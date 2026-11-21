import type { Resolvers } from "@/generated/graphql/resolvers";
import { requirePermission, requireViewer } from "../access";
import { idOrInvalidAccount, managerServices } from "./members.utils";

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
