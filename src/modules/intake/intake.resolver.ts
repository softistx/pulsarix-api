import type { Resolvers } from "@/generated/graphql/resolvers";
import { requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { IssuesService } from "../issues/public";
import {
  filePreviewUrl,
  filesOfReport,
  fileUrl,
  releasedFilesOfIssue,
} from "./intake.files.team";
import { type KeysCore, WidgetKeysService } from "./intake.keys";
import { ReportsService } from "./intake.reports";

// The key admin: `intake:manage`, and for a key's creation or rotation a
// recent proof of identity (plan §11, "step-up for key creation").
async function keysOf(ctx: Context, fresh = false) {
  const { mongo, tenant, core } = await requirePermission(ctx, "intake:manage");
  const viewer = requireViewer(ctx);
  if (fresh) ctx.services.requireFresh(viewer);
  return new WidgetKeysService(
    (core as never as { as: (id: string) => KeysCore }).as(viewer.id),
    mongo as never,
    tenant._id.toHexString(),
  );
}

// The inbox: those who write issues triage.
async function reportsOf(ctx: Context) {
  const { mongo, tenant } = await requirePermission(ctx, "issue:write");
  const viewerId = requireViewer(ctx).id;
  const organisationId = tenant._id.toHexString();
  return new ReportsService(
    mongo as never,
    new IssuesService(
      mongo,
      async (accountId) =>
        (await ctx.services.roleOf(organisationId, accountId)) !== null,
      viewerId,
      organisationId,
    ),
    viewerId,
  );
}

export const intakeResolvers: Resolvers = {
  Query: {
    widgetKeys: async (_, { projectId }, ctx) =>
      (await keysOf(ctx)).list(projectId),
    clientReports: async (_, { projectId, state, first, after }, ctx) =>
      (await reportsOf(ctx)).list(projectId, state, first, after),
    issueClientReportFiles: async (_, { issueId }, ctx) => {
      const { mongo } = await requirePermission(ctx, "attachment:read");
      return releasedFilesOfIssue(mongo as never, issueId);
    },
  },
  Mutation: {
    createWidgetKey: async (_, { input }, ctx) =>
      (await keysOf(ctx, true)).create(input),
    updateWidgetKey: async (_, { id, input }, ctx) =>
      (await keysOf(ctx)).update(id, input),
    rotateWidgetKey: async (_, { id }, ctx) =>
      (await keysOf(ctx, true)).rotate(id),
    revokeWidgetKey: async (_, { id }, ctx) => (await keysOf(ctx)).revoke(id),
    acceptClientReport: async (_, { id }, ctx) =>
      (await reportsOf(ctx)).accept(id),
    declineClientReport: async (_, { id, reason }, ctx) =>
      (await reportsOf(ctx)).decline(id, reason),
  },
  WidgetKey: {
    projectId: (key) => key.projectId.toHexString(),
    refusals: (key) =>
      Object.entries(key.refusals)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  },
  ClientReport: {
    projectId: (report) => report.projectId.toHexString(),
    issueId: (report) => report.issueId?.toHexString() ?? null,
    // Quarantined files are the inbox's: the field asks for the permission
    // the report's own queries ask for, whatever parent it comes from.
    files: async (report, _, ctx) => {
      const { mongo } = await requirePermission(ctx, "issue:write");
      return filesOfReport(mongo as never, report._id);
    },
  },
  ClientReportFile: {
    reportId: (file) => file.reportId.toHexString(),
    url: (file) => fileUrl(file),
    previewUrl: (file) => filePreviewUrl(file),
  },
};
