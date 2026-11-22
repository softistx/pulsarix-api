import { runAfterCommit } from "../../../core/shared/after-commit";
import { invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import type { IssuesService } from "../../issues/public";
import { projectNotFound } from "../../projects/public";
import { reportNotFound } from "../intake.errors";
import { announceChanged } from "../intake.live";
import type { IntakeMongo, ReportPage } from "../intake.types";
import type { ClientReportDocument, ReportState } from "../models";
import { pageOf } from "../utils/reports.utils";
import { releaseFiles } from "./files-team.service";
import { scheduleReporterMails } from "./notify.service";
import { prefillOf } from "./prefill.service";
import { type ClaimExtra, claimReport } from "./report-claim.service";
import { type NewIssueInput, ReportLinks } from "./reports-links.service";

export const MAX_PAGE = 100;

// The inbox: the client reports of the organisation, for those who triage.
// `issues` makes the issue an acceptance asks for, as the viewer.
export class ReportsService {
  private readonly links: ReportLinks;

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
  ) {
    this.links = new ReportLinks(mongo, issues, viewerId, {
      byId: (id) => this.byId(id),
      told: (report) => this.told(report),
      release: (report, what) => this.release(report, what),
    });
  }

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
    return pageOf(found, limit);
  }

  // The reporter's stream hears that their request was decided.
  private async told(
    report: ClientReportDocument,
  ): Promise<ClientReportDocument> {
    await runAfterCommit([
      announceChanged(this.options.organisationId ?? "", [report]),
      // A decline, an acceptance or a link may change the public state: the
      // reporter's e-mail follows (services/notify.service.ts).
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

  private claim(
    report: ClientReportDocument,
    state: "accepted" | "declined",
    extra: ClaimExtra = {},
  ) {
    return claimReport(this.mongo, this.viewerId, report, state, extra);
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
        ...prefillOf(report),
      });
      created = true;
      // The files go to the issue in place (services/files-team.service.ts). The report
      // is accepted whatever happens here: a release that fails is retried by
      // the files retention job (`releaseStranded`), not by the triager.
      await this.release(report, "an accepted report");
      // `issueId` was set in the issue's own transaction (services/closing.service.ts).
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

  // The links between a request and the issues of the team
  // (services/reports-links.service.ts).
  createIssues(id: string, issues: NewIssueInput[]) {
    return this.links.createIssues(id, issues);
  }

  link(id: string, issueId: string) {
    return this.links.link(id, issueId);
  }

  unlink(id: string, issueId: string) {
    return this.links.unlink(id, issueId);
  }

  // The report's files go to its issue; a release that fails is logged, never
  // thrown (the files retention job retries it).
  private async release(report: ClientReportDocument, what: string) {
    await (this.options.release ?? releaseFiles)(this.mongo, report._id).catch(
      (error) =>
        (this.options.log ?? ((m, e) => console.warn(m, e)))(
          `intake: releasing the files of ${what} failed`,
          error,
        ),
    );
  }
}
