import { TRACKING_FILES_PATH } from "./intake.http";
import { type PublicContext, withIsoTickets } from "./intake.public.context";
import {
  trackingEmails,
  trackingErase,
  trackingReopen,
  trackingReply,
  trackingResolve,
} from "./intake.tracking.actions";

// The resolvers of the tracking page's calls (for the UI server): the
// tracking token in the caller, never a key or an identity.

export const trackingQuery = {
  clientReportStatus: async (
    _: unknown,
    args: { token?: string | null },
    ctx: PublicContext,
  ) => {
    const tracked = await ctx.intake.status(
      ctx.caller.tracking ?? args.token ?? "",
      ctx.caller.ip,
    );
    const { request } = tracked;
    return {
      id: request.id,
      description: request.description,
      impact: request.impact,
      type: request.type,
      thread: request.thread,
      canReply: request.canReply,
      canReopen: request.canReopen,
      resolvedAt: request.resolvedAt,
      emailsOn: request.emailsOn,
      state: tracked.state,
      publicState: tracked.publicState,
      declineReason: tracked.declineReason,
      title: tracked.title,
      createdAt: tracked.createdAt.toISOString(),
      replies: tracked.replies.map((reply) => ({
        at: reply.at.toISOString(),
        body: reply.body,
      })),
      files: tracked.files.map((file) => ({
        id: file.id,
        role: file.role,
        name: file.name,
        thumbnailUrl: file.thumbnail
          ? `${TRACKING_FILES_PATH}/${file.id}`
          : null,
      })),
    };
  },
};

export const trackingMutation = {
  trackingReply: async (
    _: unknown,
    args: { input: Parameters<typeof trackingReply>[3] },
    ctx: PublicContext,
  ) =>
    withIsoTickets(
      await trackingReply(
        ctx.intake,
        ctx.caller.tracking ?? null,
        ctx.caller.ip,
        args.input,
      ),
    ),
  trackingResolve: (_: unknown, __: unknown, ctx: PublicContext) =>
    trackingResolve(ctx.intake, ctx.caller.tracking ?? null, ctx.caller.ip),
  trackingReopen: (_: unknown, __: unknown, ctx: PublicContext) =>
    trackingReopen(ctx.intake, ctx.caller.tracking ?? null, ctx.caller.ip),
  trackingErase: (_: unknown, __: unknown, ctx: PublicContext) =>
    trackingErase(ctx.intake, ctx.caller.tracking ?? null, ctx.caller.ip),
  trackingEmails: (_: unknown, args: { on: boolean }, ctx: PublicContext) =>
    trackingEmails(
      ctx.intake,
      ctx.caller.tracking ?? null,
      ctx.caller.ip,
      args.on,
    ),
};
