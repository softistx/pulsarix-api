import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "../../http/context";
import { requirePermission, requireViewer } from "../access";
import { idOrInvalid } from "../shared/ids";

// The invitations service once the viewer manages members (`member:manage`).
async function managerServices(ctx: Context) {
  const { tenant, member } = await requirePermission(ctx, "member:manage");
  return ctx.services.invitations(tenant, member, requireViewer(ctx).id);
}

export const invitationsResolvers: Resolvers = {
  Query: {
    invitations: async (_, { status }, ctx) =>
      (await managerServices(ctx)).list(status),
  },
  Mutation: {
    inviteMember: async (_, { input }, ctx) =>
      (await managerServices(ctx)).invite(input),
    resendInvitation: async (_, { id }, ctx) =>
      (await managerServices(ctx)).resend(idOrInvalid(id).toHexString()),
    revokeInvitation: async (_, { id }, ctx) =>
      (await managerServices(ctx)).revoke(idOrInvalid(id).toHexString()),
    acceptInvitation: (_, { token, password }, ctx) =>
      ctx.services.acceptance.accept(token, password),
  },
  Invitation: {
    id: (invitation) => invitation._id.toHexString(),
  },
};
