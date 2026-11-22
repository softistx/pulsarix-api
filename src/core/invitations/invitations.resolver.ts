import type { Resolvers } from "@/generated/graphql/resolvers";
import { idOrInvalid } from "../shared/ids";
import { throttleIp } from "../shared/throttle";
import { managerServices, readerServices } from "./invitations.utils";

export const invitationsResolvers: Resolvers = {
  Query: {
    invitations: async (_, { status }, ctx) =>
      (await readerServices(ctx)).list(status),
  },
  Mutation: {
    inviteMember: async (_, { input }, ctx) =>
      (await managerServices(ctx)).invite(input),
    resendInvitation: async (_, { id }, ctx) =>
      (await managerServices(ctx)).resend(idOrInvalid(id).toHexString()),
    revokeInvitation: async (_, { id }, ctx) =>
      (await managerServices(ctx)).revoke(idOrInvalid(id).toHexString()),
    acceptInvitation: async (_, { token, password }, ctx) => {
      await throttleIp(ctx.services.limits?.acceptInvitationIp, ctx.ip);
      return ctx.services.acceptance.accept(token, password);
    },
  },
  Invitation: {
    id: (invitation) => invitation._id.toHexString(),
  },
};
