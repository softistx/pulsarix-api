import { boundedStream } from "@softistx/alxia-graphql";
import { realtime } from "../../config/redis";
import {
  enforceSecondFactor,
  requireMember,
  requirePermission,
  requireViewer,
} from "../../core/access";
import { idOrInvalid } from "../../core/shared/ids";
import type { Context } from "../../http/context";
import { issueNotFound } from "../issues/public";
import { projectNotFound } from "../projects/public";

// A stream ends after this long without an event, or in all; the client
// reconnects and refetches. The viewer's right is checked again every
// `checkEveryMs`.
export const STREAM_LIMITS = {
  idleMs: 15 * 60_000,
  totalMs: 60 * 60_000,
  checkEveryMs: 30_000,
};

type Permission = "issue:read" | "issue:write";

// The viewer and the organisation, once the guard let them in; `holds` asks
// again, with a fresh read of the membership, whether the viewer still may.
async function open(ctx: Context, permission: Permission | null) {
  const scope = permission
    ? await requirePermission(ctx, permission)
    : await requireMember(ctx);
  const viewer = requireViewer(ctx);
  const viewerId = viewer.id;
  const organisationId = scope.tenant._id.toHexString();
  const holds = async () => {
    const role = await ctx.services.roleOf(organisationId, viewerId);
    if (
      role === null ||
      (permission && !ctx.access.roleCan(role, permission))
    ) {
      throw new Error("no longer allowed");
    }
    // The organisation may have started requiring a second factor since.
    const current = await scope.core.db.organisations.findById(
      scope.tenant._id,
    );
    if (!current) throw new Error("no longer allowed");
    enforceSecondFactor(viewer, { member: role, tenant: current });
  };
  return { mongo: scope.mongo, viewerId, organisationId, holds };
}

const bounded = <T>(source: AsyncIterable<T>, holds: () => Promise<void>) =>
  boundedStream(source, { ...STREAM_LIMITS, check: holds });

export const openProjectBoard = async (ctx: Context, projectId: string) => {
  const { mongo, organisationId, holds } = await open(ctx, "issue:read");
  const project = idOrInvalid(projectId, "projectId");
  if (!(await mongo.db.projects.exists({ _id: project }))) {
    throw projectNotFound();
  }
  return bounded(
    realtime.channels.projectBoard.stream(
      `${organisationId}:${project.toHexString()}`,
    ),
    holds,
  );
};

export const openIssueChanged = async (ctx: Context, issueId: string) => {
  const { mongo, organisationId, holds } = await open(ctx, "issue:read");
  const issue = idOrInvalid(issueId, "issueId");
  if (!(await mongo.db.issues.exists({ _id: issue }))) throw issueNotFound();
  return bounded(
    realtime.channels.issueChanged.stream(
      `${organisationId}:${issue.toHexString()}`,
    ),
    holds,
  );
};

// Own topic only: the key names the viewer, never an argument.
export const openNotifications = async (ctx: Context) => {
  const { organisationId, viewerId, holds } = await open(ctx, null);
  return bounded(
    realtime.channels.notificationReceived.stream(
      `${organisationId}:${viewerId}`,
    ),
    holds,
  );
};

// The inbox is for those who triage: who writes issues.
export const openClientReports = async (ctx: Context, projectId: string) => {
  const { mongo, organisationId, holds } = await open(ctx, "issue:write");
  const project = idOrInvalid(projectId, "projectId");
  if (!(await mongo.db.projects.exists({ _id: project }))) {
    throw projectNotFound();
  }
  return bounded(
    realtime.channels.clientReportReceived.stream(
      `${organisationId}:${project.toHexString()}`,
    ),
    holds,
  );
};

// The files of those reports, for the same people.
export const openClientReportFiles = async (
  ctx: Context,
  projectId: string,
) => {
  const { mongo, organisationId, holds } = await open(ctx, "issue:write");
  const project = idOrInvalid(projectId, "projectId");
  if (!(await mongo.db.projects.exists({ _id: project }))) {
    throw projectNotFound();
  }
  return bounded(
    realtime.channels.clientReportFileReceived.stream(
      `${organisationId}:${project.toHexString()}`,
    ),
    holds,
  );
};

// The messages of those reports' threads, for the same people.
export const openClientReportMessages = async (
  ctx: Context,
  projectId: string,
) => {
  const { mongo, organisationId, holds } = await open(ctx, "issue:write");
  const project = idOrInvalid(projectId, "projectId");
  if (!(await mongo.db.projects.exists({ _id: project }))) {
    throw projectNotFound();
  }
  return bounded(
    realtime.channels.clientReportMessageReceived.stream(
      `${organisationId}:${project.toHexString()}`,
    ),
    holds,
  );
};

// Every request of the organisation, for those who triage: the organisation's
// whole inbox, whatever the project.
export const openRequests = async (ctx: Context) => {
  const { organisationId, holds } = await open(ctx, "issue:write");
  return bounded(
    realtime.channels.requestsChanged.stream(organisationId),
    holds,
  );
};
