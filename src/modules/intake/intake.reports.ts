import { OptimisticLockError } from "@softistx/mongo";
import type { ModuleMongo } from "../../config/db";
import { runAfterCommit } from "../../core/shared/after-commit";
import { invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import {
  assertProjectWritable,
  type IssuesService,
  issueNotFound,
} from "../issues/public";
import { projectNotFound } from "../projects/public";
import { isSettled } from "./intake.closing";
import { reportDecided, reportNotFound } from "./intake.errors";
import { releaseFiles } from "./intake.files.team";
import { announceChanged } from "./intake.live";
import type { ClientReportDocument, ReportState } from "./intake.model";
import { scheduleReporterMails } from "./intake.notify";
import { prefillOf } from "./intake.prefill";
import { refreshIssueWaiting } from "./intake.waiting";

export type IntakeMongo = ModuleMongo<"intake">;

export const MAX_PAGE = 100;

export interface ReportPage {
  nodes: ClientReportDocument[];
  endCursor: string | null;
  hasNextPage: boolean;
}

// The inbox: the client reports of the organisation, for those who triage.
// `issues` makes the issue an acceptance asks for, as the viewer.
export class ReportsService {
  constructor(
    private readonly mongo: IntakeMongo,
    private readonly issues: IssuesService,
    private readonly viewerId: string,
    private readonly options: {
      // Injected by a spec; the files retention job retries a failed release.
      release?: typeof releaseFiles;
      log?: (message: string, error: unknown) => void;
      // The organisation, for the live event the reporter's stream hears.
      organisationId?: string;
    } = {},
  ) {}

  async list(
    projectId: string,
    state: ReportState | null | undefined,
    first: number | null | undefined,
    after?: string | null,
  ): Promise<ReportPage> {
    const limit = first ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw invalid([
        { path: "first", code: "validation.errors.out-of-range" },
      ]);
    }
    const project = idOrInvalid(projectId, "projectId");
    if (!(await this.mongo.db.projects.exists({ _id: project }))) {
      throw projectNotFound();
    }
    const cursor = after ? idOrInvalid(after, "after") : null;
    const found = await this.mongo.db.clientReports.findMany({
      filter: {
        projectId: project,
        ...(state && { state }),
        ...(cursor && { _id: { $lt: cursor } }),
      },
      sort: { _id: -1 },
      limit: limit + 1,
    });
    const nodes = found.slice(0, limit);
    const last = nodes.at(-1);
    const hasNextPage = found.length > limit;
    return {
      nodes,
      endCursor: hasNextPage && last ? last.id : null,
      hasNextPage,
    };
  }

  // The reporter's stream hears that their request was decided.
  private async told(
    report: ClientReportDocument,
  ): Promise<ClientReportDocument> {
    await runAfterCommit([
      announceChanged(this.options.organisationId ?? "", [report]),
      // A decline, an acceptance or a link may change the public state: the
      // reporter's e-mail follows (intake.notify.ts).
      scheduleReporterMails(this.options.organisationId ?? "", [report]),
    ]);
    return report;
  }

  private async byId(id: string): Promise<ClientReportDocument> {
    const found = await this.mongo.db.clientReports.findById(
      idOrInvalid(id, "id"),
    );
    if (!found) throw reportNotFound();
    return found;
  }

  // Decides a new report: the state change is claimed first, with the version
  // read, so two members deciding at once cannot both win (the loser gets 409).
  private async claim(
    report: ClientReportDocument,
    state: "accepted" | "declined",
    extra: Partial<
      Pick<
        ClientReportDocument,
        "declineReason" | "declineReasonPublic" | "issueId" | "linkedAt"
      >
    > = {},
  ): Promise<ClientReportDocument> {
    if (report.state !== "new") throw reportDecided();
    try {
      return await this.mongo.db.clientReports.update(report._id, {
        state,
        decidedBy: this.viewerId,
        decidedAt: new Date(),
        ...extra,
        version: report.version,
      });
    } catch (error) {
      if (error instanceof OptimisticLockError) throw reportDecided();
      throw error;
    }
  }

  // Accepts a new report: an issue in the project's Triage status (the default
  // status if the project has none left) carrying the report's id, and the
  // report pointing back at it. If the issue cannot be made, the report is
  // new again.
  async accept(id: string): Promise<ClientReportDocument> {
    return this.told(await this.acceptReport(id));
  }

  private async acceptReport(id: string): Promise<ClientReportDocument> {
    const report = await this.byId(id);
    const claimed = await this.claim(report, "accepted");
    let created = false;
    try {
      const triage = await this.mongo.db.statuses.findFirst({
        projectId: report.projectId,
        category: "triage",
      });
      await this.issues.create({
        projectId: report.projectId.toHexString(),
        title: report.title,
        description: report.description,
        statusId: triage?.id ?? null,
        clientReportId: report._id,
        ...(await prefillOf(this.mongo, report)),
      });
      created = true;
      // The files go to the issue in place (intake.files.team.ts). The report
      // is accepted whatever happens here: a release that fails is retried by
      // the files retention job (`releaseStranded`), not by the triager.
      await (this.options.release ?? releaseFiles)(
        this.mongo,
        report._id,
      ).catch((error) =>
        (this.options.log ?? ((m, e) => console.warn(m, e)))(
          "intake: releasing the files of an accepted report failed",
          error,
        ),
      );
      // `issueId` was set in the issue's own transaction (intake.closing.ts).
      return await this.byId(claimed._id.toHexString());
    } catch (error) {
      // Only a failed creation puts the report back to new.
      if (!created) {
        await this.mongo.db.clientReports
          .update(claimed._id, {
            state: "new",
            decidedBy: null,
            decidedAt: null,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async decline(id: string, reason: string): Promise<ClientReportDocument> {
    return this.told(await this.declineReport(id, reason));
  }

  private async declineReport(
    id: string,
    reason: string,
  ): Promise<ClientReportDocument> {
    const text = reason.trim();
    if (!text) {
      throw invalid([{ path: "reason", code: "validation.errors.required" }]);
    }
    // The reason is shown to the reporter (plan §19); the dialog says so.
    return this.claim(await this.byId(id), "declined", {
      declineReason: text,
      declineReasonPublic: true,
    });
  }

  // Accepts a new report into an issue that already exists (a duplicate): no
  // issue is made, the report points at the issue and follows it from then on
  // (intake.closing.ts), and its files are released to it.
  async link(id: string, issueId: string): Promise<ClientReportDocument> {
    return this.told(await this.linkReport(id, issueId));
  }

  private async linkReport(
    id: string,
    issueId: string,
  ): Promise<ClientReportDocument> {
    const report = await this.byId(id);
    const issue = await this.mongo.db.issues.findById(
      idOrInvalid(issueId, "issueId"),
    );
    if (!issue) throw issueNotFound();
    if (!issue.projectId.equals(report.projectId)) {
      throw invalid([{ path: "issueId", code: "validation.errors.invalid" }]);
    }
    await assertProjectWritable(this.mongo, issue.projectId);
    await this.claim(report, "accepted", {
      issueId: issue._id,
      linkedAt: new Date(),
    });
    // The issue may already be settled: the report is then closed at once.
    // Read again after the claim, so a change that committed meanwhile (which
    // could not see the report yet) is not missed; a vanished issue is settled.
    const fresh = await this.mongo.db.issues.findById(issue._id);
    if (!fresh || (await isSettled(this.mongo, fresh))) {
      await this.mongo.db.clientReports.update(report._id, {
        state: "closed",
        closedAt: new Date(),
      });
    }
    // A reporter who is waiting makes the issue wait.
    if (report.clientWaiting === true) {
      await refreshIssueWaiting(
        this.mongo as unknown as Parameters<typeof refreshIssueWaiting>[0],
        issue._id,
      );
    }
    await (this.options.release ?? releaseFiles)(this.mongo, report._id).catch(
      (error) =>
        (this.options.log ?? ((m, e) => console.warn(m, e)))(
          "intake: releasing the files of a linked report failed",
          error,
        ),
    );
    return this.byId(id);
  }
}
