import type { PublicIntake, Submitted } from "../services";
import {
  eraseMyData,
  markRequestRead,
  myRequests,
  openSession,
  type RequestFilter,
  reopenRequest,
  replyToRequest,
  requestOf,
  resolveRequest,
  setRequestEmails,
} from "../services";
import { type PublicContext, withIsoTickets } from "./support";

// The resolvers of the widget's calls: the key in the arguments, the reporter
// by their identity token (`openSession`).

const submitted = async (pending: Promise<Submitted>) =>
  withIsoTickets(await pending);

export const reporterQuery = {
  myRequests: async (
    _: unknown,
    args: {
      publicKey: string;
      filter?: RequestFilter | null;
      first?: number | null;
      after?: string | null;
    },
    ctx: PublicContext,
  ) =>
    myRequests(await openSession(ctx.intake, args.publicKey, ctx.caller), args),
  request: async (
    _: unknown,
    args: { publicKey: string; id: string },
    ctx: PublicContext,
  ) =>
    requestOf(
      ctx.intake,
      await openSession(ctx.intake, args.publicKey, ctx.caller),
      args.id,
    ),
  widgetConfig: (_: unknown, args: { publicKey: string }, ctx: PublicContext) =>
    ctx.intake.config(args.publicKey, ctx.caller),
};

export const reporterMutation = {
  replyToRequest: async (
    _: unknown,
    args: {
      publicKey: string;
      id: string;
      input: Parameters<typeof replyToRequest>[3];
    },
    ctx: PublicContext,
  ) => {
    const session = await openSession(ctx.intake, args.publicKey, ctx.caller);
    return withIsoTickets(
      await replyToRequest(ctx.intake, session, args.id, args.input),
    );
  },
  resolveRequest: async (
    _: unknown,
    args: { publicKey: string; id: string },
    ctx: PublicContext,
  ) =>
    resolveRequest(
      ctx.intake,
      await openSession(ctx.intake, args.publicKey, ctx.caller),
      args.id,
    ),
  reopenRequest: async (
    _: unknown,
    args: { publicKey: string; id: string },
    ctx: PublicContext,
  ) =>
    reopenRequest(
      ctx.intake,
      await openSession(ctx.intake, args.publicKey, ctx.caller),
      args.id,
    ),
  markRequestRead: async (
    _: unknown,
    args: { publicKey: string; id: string },
    ctx: PublicContext,
  ) =>
    markRequestRead(
      ctx.intake,
      await openSession(ctx.intake, args.publicKey, ctx.caller),
      args.id,
    ),
  setRequestEmails: async (
    _: unknown,
    args: { publicKey: string; on: boolean },
    ctx: PublicContext,
  ) =>
    setRequestEmails(
      await openSession(ctx.intake, args.publicKey, ctx.caller),
      args.on,
    ),
  eraseMyData: async (
    _: unknown,
    args: { publicKey: string },
    ctx: PublicContext,
  ) =>
    eraseMyData(
      ctx.intake,
      await openSession(ctx.intake, args.publicKey, ctx.caller),
    ),
  submitClientReport: (
    _: unknown,
    args: {
      publicKey: string;
      input: Parameters<PublicIntake["submit"]>[1];
    },
    ctx: PublicContext,
  ) => submitted(ctx.intake.submit(args.publicKey, args.input, ctx.caller)),
};
