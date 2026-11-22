import type { Resolvers } from "@/generated/graphql/resolvers";
import { requirePermission } from "../../../core/access";
import { dataLoaders } from "../../data-loaders";
import {
  countRequests,
  filePreviewUrl,
  fileUrl,
  listRequests,
  releasedFilesOfIssue,
  replyToClientRequest,
  requestById,
  teamThread,
} from "../services";
import { attachmentsOn } from "../utils/attachments.utils";
import { keysOf, reportsOf, triageOf } from "./support";

export const intakeResolvers: Resolvers = {
  Query: {
    widgetKeys: async (_, { projectId }, ctx) =>
      (await keysOf(ctx)).list(projectId),
    clientReports: async (_, args, ctx) =>
      listRequests((await triageOf(ctx)).mongo, args),
    clientReportCounts: async (_, { projectId }, ctx) =>
      countRequests((await triageOf(ctx)).mongo, projectId),
    clientReport: async (_, { id }, ctx) =>
      requestById((await triageOf(ctx)).mongo, id),
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
    createIssuesFromClientReport: async (_, { id, issues }, ctx) =>
      (await reportsOf(ctx)).createIssues(id, issues),
    unlinkClientReport: async (_, { id, issueId }, ctx) =>
      (await reportsOf(ctx)).unlink(id, issueId),
    linkClientReport: async (_, { id, issueId }, ctx) =>
      (await reportsOf(ctx)).link(id, issueId),
    replyToClientReport: async (_, { id, input }, ctx) => {
      const { mongo, viewerId, organisationId } = await triageOf(ctx);
      return replyToClientRequest(
        mongo,
        { viewerId, organisationId },
        id,
        input.body,
      );
    },
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
  Issue: {
    waitingClients: (issue, _, ctx) =>
      dataLoaders(ctx).intake.waitingClients.load(issue.id),
    clientReports: (issue, _, ctx) =>
      dataLoaders(ctx).intake.issueReports.load(issue.id),
  },
  ClientReport: {
    projectId: (report) => report.projectId.toHexString(),
    issueId: (report) => report.issueId?.toHexString() ?? null,
    issueIds: async (report, _, ctx) =>
      (await dataLoaders(ctx).intake.links.load(report._id.toHexString())).map(
        (issue) => issue.id,
      ),
    issues: (report, _, ctx) =>
      dataLoaders(ctx).intake.links.load(report._id.toHexString()),
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
    thread: async (report, _, ctx) =>
      teamThread((await triageOf(ctx)).mongo, report),
    pendingFiles: (report, _, ctx) =>
      dataLoaders(ctx).intake.pending.load(report._id.toHexString()),
  },
  ClientReportFile: {
    reportId: (file) => file.reportId.toHexString(),
    url: (file) => fileUrl(file),
    previewUrl: (file) => filePreviewUrl(file),
  },
};
