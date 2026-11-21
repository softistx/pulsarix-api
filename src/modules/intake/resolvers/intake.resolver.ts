import type { ObjectId } from "mongodb";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { requirePermission, requireViewer } from "../../../core/access";
import type { Context } from "../../../http/context";
import { dataLoaders } from "../../data-loaders";
import { IssuesService } from "../../issues/public";
import {
  filePreviewUrl,
  fileUrl,
  pendingCountsOf,
  releasedFilesOfIssue,
} from "../services/files-team.service";
import { WidgetKeysService } from "../services/keys.service";
import { ReportsService } from "../services/reports.service";
import { publicStateLoaderOf } from "../services/requests-state.service";
import { attachmentsOn } from "../models";

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

// `pendingFiles` is batched per request: the reports resolved in the same
// macrotask (a page of the inbox) share one grouped read instead of one count
// each.
type PendingBatch = {
  ids: Map<string, ObjectId>;
  counts: Promise<Map<string, number>>;
};
const pendingBatches = new WeakMap<Context, PendingBatch>();

function pendingOf(
  ctx: Context,
  mongo: Parameters<typeof pendingCountsOf>[0],
  reportId: ObjectId,
): Promise<number> {
  let batch = pendingBatches.get(ctx);
  if (!batch) {
    const ids = new Map<string, ObjectId>();
    batch = {
      ids,
      counts: new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
        () => {
          pendingBatches.delete(ctx);
          return pendingCountsOf(mongo, [...ids.values()]);
        },
      ),
    };
    pendingBatches.set(ctx, batch);
  }
  const key = reportId.toHexString();
  batch.ids.set(key, reportId);
  return batch.counts.then((counts) => counts.get(key) ?? 0);
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
    publicState: async (report, _, ctx) => {
      const { mongo } = await requirePermission(ctx, "issue:write");
      // One read of the issues and statuses per request, whatever the
      // number of reports the field is asked for.
      return publicStateLoaderOf(ctx, mongo)(report);
    },
    // Quarantined files are the inbox's: the field asks for the permission
    // the report's own queries ask for, whatever parent it comes from.
    files: (report, _, ctx) =>
      dataLoaders(ctx).intake.files.load(report._id.toHexString()),
    pendingFiles: async (report, _, ctx) => {
      const { mongo } = await requirePermission(ctx, "issue:write");
      return pendingOf(ctx, mongo, report._id);
    },
  },
  ClientReportFile: {
    reportId: (file) => file.reportId.toHexString(),
    url: (file) => fileUrl(file),
    previewUrl: (file) => filePreviewUrl(file),
  },
};
