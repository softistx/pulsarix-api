import { OptimisticLockError } from "@softistx/mongo";
import type { ModuleMongo } from "../../config/db";
import { invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import type { IssuesService } from "../issues/public";
import { projectNotFound } from "../projects/projects.errors";
import { reportDecided, reportNotFound } from "./intake.errors";
import type { ClientReportDocument, ReportState } from "./intake.model";

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
    extra: { declineReason?: string } = {},
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
    const report = await this.byId(id);
    const claimed = await this.claim(report, "accepted");
    try {
      const triage = await this.mongo.db.statuses.findFirst({
        projectId: report.projectId,
        category: "triage",
      });
      const issue = await this.issues.create({
        projectId: report.projectId.toHexString(),
        title: report.title,
        description: report.description,
        statusId: triage?.id ?? null,
        clientReportId: report._id,
      });
      return await this.mongo.db.clientReports.update(claimed._id, {
        issueId: issue._id,
      });
    } catch (error) {
      await this.mongo.db.clientReports.update(claimed._id, {
        state: "new",
        decidedBy: null,
        decidedAt: null,
      });
      throw error;
    }
  }

  async decline(id: string, reason: string): Promise<ClientReportDocument> {
    const text = reason.trim();
    if (!text) {
      throw invalid([{ path: "reason", code: "validation.errors.required" }]);
    }
    return this.claim(await this.byId(id), "declined", {
      declineReason: text,
    });
  }
}
