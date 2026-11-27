import { requirePermission, requireViewer } from "../../../core/access";
import type { Context } from "../../../http/context";
import { IssuesService } from "../../issues/public";
import type { Caller, PublicIntake } from "../services";
import { ReportsService, WidgetKeysService } from "../services";

// What a resolver of /public/graphql reads: the intake and who calls.
export interface PublicContext {
  intake: PublicIntake;
  caller: Caller;
}

// A reply's or a report's file tickets, their expiry as the wire carries it.
export const withIsoTickets = <T extends { files: { expiresAt: Date }[] }>(
  done: T,
) => ({
  ...done,
  files: done.files.map((file) => ({
    ...file,
    expiresAt: file.expiresAt.toISOString(),
  })),
});

// The key admin: `intake:manage`, and for a key's creation or rotation a
// recent proof of identity (plan §11, "step-up for key creation").
export async function keysOf(ctx: Context, fresh = false) {
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
export async function reportsOf(ctx: Context) {
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
      tenant.timeZone,
    ),
    viewerId,
    { organisationId },
  );
}

// The inbox's reads: the permission, the database and who asks.
export async function triageOf(ctx: Context) {
  const { mongo, tenant } = await requirePermission(ctx, "issue:write");
  return {
    mongo,
    viewerId: requireViewer(ctx).id,
    organisationId: tenant._id.toHexString(),
  };
}
