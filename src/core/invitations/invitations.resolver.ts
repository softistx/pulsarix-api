import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "../../http/context";
import { requirePermission, requireViewer } from "../access";
import { idOrInvalid } from "../shared/ids";
import { throttleIp } from "../shared/throttle";

// The invitations service once the viewer manages members (`member:manage`).
async function managerServices(ctx: Context) {
  const { tenant, member } = await requirePermission(ctx, "member:manage");
  const viewer = requireViewer(ctx);
  // Inviting with a role is a promotion: it asks for the same recent proof.
  ctx.services.requireFresh(viewer);
  return ctx.services.invitations(tenant, member, viewer.id);
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
    acceptInvitation: async (_, { token, password }, ctx) => {
      await throttleIp(ctx.services.limits?.acceptInvitationIp, ctx.ip);
      return ctx.services.acceptance.accept(token, password);
    },
  },
  Invitation: {
    id: (invitation) => invitation._id.toHexString(),
  },
};
