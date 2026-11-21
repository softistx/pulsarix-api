import type { Resolvers } from "@/generated/graphql/resolvers";
import { requirePermission, requireViewer } from "../../../core/access";
import type { Context } from "../../../http/context";
import { dataLoaders } from "../../data-loaders";
import { IssuesService } from "../../issues/public";
import {
  filePreviewUrl,
  fileUrl,
  releasedFilesOfIssue,
} from "../services/files-team.service";
import { WidgetKeysService } from "../services/keys.service";
import { ReportsService } from "../services/reports.service";
import { attachmentsOn } from "../utils/attachments.utils";

// The key admin: `intake:manage`, and for a key's creation or rotation a
// recent proof of identity (plan §11, "step-up for key creation").
async function keysOf(ctx: Context, fresh = false) {
  const { mongo, tenant, core } = await requirePermission(ctx, "intake:manage");
  const viewer = requireViewer(ctx);
  if (fresh) ctx.services.requireFresh(viewer);
  return new WidgetKeysService(
    core.as(viewer.id),
    mongo,
    tenant._id.toHexString(),
  );
}

// The inbox: those who write issues triage.
async function reportsOf(ctx: Context) {
  const { mongo, tenant } = await requirePermission(ctx, "issue:write");
  const viewerId = requireViewer(ctx).id;
  const organisationId = tenant._id.toHexString();
  return new ReportsService(
    mongo,
    new IssuesService(
      mongo,
      async (accountId) =>
        (await ctx.services.roleOf(organisationId, accountId)) !== null,
      viewerId,
      organisationId,
    ),
    viewerId,
    { organisationId },
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
      return releasedFilesOfIssue(mongo, issueId);
    },
  },
  Mutation: {
    createWidgetKey: async (_, { input }, ctx) =>
      (await keysOf(ctx, true)).create(input),
    updateWidgetKey: async (_, { id, input }, ctx) =>
      (await keysOf(ctx)).update(id, input),
    rotateWidgetKey: async (_, { id }, ctx) =>
      (await keysOf(ctx, true)).rotate(id),
    generateWidgetIdentitySecret: async (_, { keyId }, ctx) =>
      (await keysOf(ctx, true)).generateIdentitySecret(keyId),
    revokeWidgetKey: async (_, { id }, ctx) => (await keysOf(ctx)).revoke(id),
    acceptClientReport: async (_, { id }, ctx) =>
      (await reportsOf(ctx)).accept(id),
    declineClientReport: async (_, { id, reason }, ctx) =>
      (await reportsOf(ctx)).decline(id, reason),
    linkClientReport: async (_, { id, issueId }, ctx) =>
      (await reportsOf(ctx)).link(id, issueId),
  },
  WidgetKey: {
    projectId: (key) => key.projectId.toHexString(),
    // Keys stored before v2 lack the counters (see attachmentsOn).
    attachmentsEnabled: (key) => attachmentsOn(key),
    uploads: (key) => key.uploads ?? 0,
    identitySecretSetAt: (key) => key.identitySecretSetAt ?? null,
    refusals: (key) =>
      Object.entries(key.refusals ?? {})
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  },
  ClientReport: {
    projectId: (report) => report.projectId.toHexString(),
    issueId: (report) => report.issueId?.toHexString() ?? null,
    // Reports stored before widget v3 lack these (see declineReasonShown).
    impact: (report) => report.impact ?? null,
    type: (report) => report.type ?? null,
    declineReasonPublic: (report) => report.declineReasonPublic === true,
    linkedAt: (report) => report.linkedAt ?? null,
    clientWaiting: (report) => report.clientWaiting === true,
    // One read of the issues and statuses per batch, whatever the number of
    // reports the field is asked for.
    publicState: (report, _, ctx) =>
      dataLoaders(ctx).intake.publicState.load(report),
    // Quarantined files are the inbox's: the field asks for the permission
    // the report's own queries ask for, whatever parent it comes from.
    files: (report, _, ctx) =>
      dataLoaders(ctx).intake.files.load(report._id.toHexString()),
    pendingFiles: (report, _, ctx) =>
      dataLoaders(ctx).intake.pending.load(report._id.toHexString()),
  },
  ClientReportFile: {
    reportId: (file) => file.reportId.toHexString(),
    url: (file) => fileUrl(file),
    previewUrl: (file) => filePreviewUrl(file),
  },
};
