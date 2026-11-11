import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "../../http/context";
import { requirePermission, requireViewer } from "../access";
import { idOrInvalidAccount } from "./members.utils";

// The members service once the viewer manages them (`member:manage`) with a
// recent proof of identity: what every mutation of the module calls first.
async function managerServices(ctx: Context) {
  const { tenant } = await requirePermission(ctx, "member:manage");
  const viewer = requireViewer(ctx);
  ctx.services.requireFresh(viewer);
  return ctx.services.members(tenant, viewer.id);
}

export const membersResolvers: Resolvers = {
  Query: {
    members: async (_, __, ctx) => {
      const { tenant } = await requirePermission(ctx, "member:read");
      return ctx.services.members(tenant, requireViewer(ctx).id).list();
    },
  },
  Mutation: {
    changeMemberRole: async (_, { id, role }, ctx) =>
      (await managerServices(ctx)).changeRole(idOrInvalidAccount(id), role),
    removeMember: async (_, { id }, ctx) =>
      (await managerServices(ctx)).remove(idOrInvalidAccount(id)),
  },
};
