import { ConflictError } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { exhausted, invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { retryWriteConflicts } from "../../../core/shared/locked";
import {
  assertProjectWritable,
  type CreateIssueInput,
  type IssuesService,
  issueNotFound,
} from "../../issues/public";
import {
  issueOtherProject,
  lastLink,
  linkExists,
  reportDecided,
  reportNotFound,
} from "../intake.errors";
import type { IntakeMongo } from "../intake.types";
import type { ClientReportDocument } from "../models";
import { isSettled, settleReport } from "./closing.service";
import { linkedIssueIds } from "./linked-reports.service";
import { prefillOf } from "./prefill.service";
import { claimReport } from "./report-claim.service";
import { refreshIssueWaiting } from "./waiting.service";

export const MAX_NEW_ISSUES = 10;

// One issue the team asks for from a request.
export interface NewIssueInput {
  title: string;
  type?: CreateIssueInput["type"] | null | undefined;
  parentId?: string | null | undefined;
}

// What the links service takes from the inbox's service.
export interface LinksHost {
  byId(id: string): Promise<ClientReportDocument>;
  told(report: ClientReportDocument): Promise<ClientReportDocument>;
  release(report: ClientReportDocument, what: string): Promise<void>;
}

// The many-to-many links between a request and the issues of the team (plan
// §20.4): the issues made from it, an existing issue linked to it, a link
// removed. The links are `clientReportLinks`; `clientReports.issueId` keeps
// the first of them (deprecated) for the reads that predate the links.
export class ReportLinks {
  constructor(
    private readonly mongo: IntakeMongo,
    private readonly issues: IssuesService,
    private readonly viewerId: string,
    private readonly host: LinksHost,
  ) {}

  // Accepts the request and makes 1 to 10 issues from it in one transaction:
  // all of them or none, and the report is claimed with them. On an accepted
  // request it only adds issues.
  async createIssues(
    id: string,
    inputs: NewIssueInput[],
  ): Promise<ClientReportDocument> {
    if (inputs.length < 1 || inputs.length > MAX_NEW_ISSUES) {
      throw invalid([
        { path: "issues", code: "validation.errors.out-of-range" },
      ]);
    }
    const report = await this.host.byId(id);
    if (report.state !== "new" && report.state !== "accepted") {
      throw reportDecided();
    }
    const triage = await this.mongo.db.statuses.findFirst({
      projectId: report.projectId,
      category: "triage",
    });
    const prefill = prefillOf(report);
    await this.issues.createMany(
      inputs.map((input) => ({
        projectId: report.projectId.toHexString(),
        title: input.title,
        description: report.description,
        statusId: triage?.id ?? null,
        clientReportId: report._id,
        ...prefill,
        ...(input.type && { type: input.type }),
        ...(input.parentId && { parentId: input.parentId }),
      })),
      async (tx) => {
        if (report.state === "new") {
          await claimReport(tx, this.viewerId, report, "accepted");
        }
      },
    );
    // The files go to the issues in place; the first link releases them.
    await this.host.release(report, "an accepted report");
    return this.host.told(await this.host.byId(id));
  }

  // Links the request to an issue that already exists (a duplicate): a new
  // request is accepted by it, an accepted one only gains a link.
  async link(id: string, issueId: string): Promise<ClientReportDocument> {
    const report = await this.host.byId(id);
    const issue = await this.mongo.db.issues.findById(
      idOrInvalid(issueId, "issueId"),
    );
    if (!issue) throw issueNotFound();
    if (!issue.projectId.equals(report.projectId)) throw issueOtherProject();
    await assertProjectWritable(this.mongo, issue.projectId);
    if (report.state !== "new" && report.state !== "accepted") {
      throw reportDecided();
    }
    await this.addLink(report, issue._id);
    if (report.state === "new") await this.settleLinked(report, issue._id);
    else if (report.clientWaiting === true) {
      await refreshIssueWaiting(this.mongo, issue._id);
    }
    await this.host.release(report, "a linked report");
    return this.host.told(await this.host.byId(id));
  }

  // Removes one link; the request keeps at least one. `issueId` follows the
  // earliest link left.
  async unlink(id: string, issueId: string): Promise<ClientReportDocument> {
    const first = await this.host.byId(id);
    await assertProjectWritable(this.mongo, first.projectId);
    const issue = idOrInvalid(issueId, "issueId");
    await retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          const report = await tx.db.clientReports.findById(
            idOrInvalid(id, "id"),
          );
          if (!report) throw reportNotFound();
          const gone = await tx.db.clientReportLinks.findFirst({
            reportId: report._id,
            issueId: issue,
          });
          if (!gone) throw reportNotFound();
          const left = await tx.db.clientReportLinks.findMany({
            filter: { reportId: report._id, _id: { $ne: gone._id } },
            sort: { _id: 1 },
            limit: 1,
          });
          const next = left[0];
          if (!next) throw lastLink();
          await tx.db.clientReportLinks.hardDelete(gone._id);
          // Written every time: two unlinks racing on different links then
          // conflict on the report and the second one sees the first.
          await tx.db.clientReports.update(report._id, {
            issueId: next.issueId,
          });
          // The issues left may all be settled: the request then closes.
          const ids = (await linkedIssueIds(tx, [report])).get(report.id);
          await settleReport(tx, report, ids ?? []);
          if (report.clientWaiting === true) {
            await refreshIssueWaiting(tx, issue);
          }
        }),
      exhausted,
    );
    return this.host.told(await this.host.byId(id));
  }

  // The link and, on a new request, its acceptance: together, so a refused
  // link leaves the request new.
  private async addLink(report: ClientReportDocument, issueId: ObjectId) {
    await retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          const current = await tx.db.clientReports.findById(report._id);
          if (!current) throw reportNotFound();
          if (current.state !== "new" && current.state !== "accepted") {
            throw reportDecided();
          }
          if (
            await tx.db.clientReportLinks.exists({
              reportId: report._id,
              issueId,
            })
          ) {
            throw linkExists();
          }
          const now = new Date();
          if (current.state === "new") {
            await claimReport(tx, this.viewerId, current, "accepted", {
              issueId,
              linkedAt: now,
            });
          } else if (current.issueId === null) {
            await tx.db.clientReports.update(report._id, { issueId });
          }
          try {
            await tx.db.clientReportLinks.create({
              reportId: report._id,
              issueId,
              linkedAt: now,
              linkedBy: this.viewerId,
            });
          } catch (error) {
            if (error instanceof ConflictError) throw linkExists();
            throw error;
          }
        }),
      exhausted,
    );
  }

  // The issue may already be settled: the report is then closed at once. Read
  // again after the claim, so a change that committed meanwhile (which could
  // not see the report yet) is not missed; a vanished issue is settled. A
  // reporter who is waiting makes the issue wait.
  private async settleLinked(report: ClientReportDocument, issueId: ObjectId) {
    const fresh = await this.mongo.db.issues.findById(issueId);
    if (!fresh || (await isSettled(this.mongo, fresh))) {
      await this.mongo.db.clientReports.update(report._id, {
        state: "closed",
        closedAt: new Date(),
      });
    }
    if (report.clientWaiting === true) {
      await refreshIssueWaiting(this.mongo, issueId);
    }
  }
}
