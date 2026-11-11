import type { Resolvers } from "@/generated/graphql/resolvers";
import {
  requireAccountPermission,
  requireMember,
  requirePermission,
  requireViewer,
} from "../access";

export const organisations: Resolvers = {
  Query: {
    organisation: async (_, __, ctx) => (await requireMember(ctx)).tenant,
    myOrganisations: async (_, __, ctx) => {
      const mine = await ctx.services.organisations.mine(requireViewer(ctx).id);
      // The roles are known already: `viewerPermissions` of the nested
      // organisations reads them from here, not again.
      for (const { organisation, role } of mine) {
        ctx.memberships.prime(organisation.id, role);
      }
      return mine;
    },
  },
  Mutation: {
    createOrganisation: async (_, { input }, ctx) => {
      const viewer = requireAccountPermission(ctx, "organisation:create");
      const created = await ctx.services.organisations.create(viewer.id, input);
      ctx.memberships.prime(created.organisation.id, created.role);
      return created;
    },
    updateOrganisation: async (_, { input }, ctx) => {
      const { tenant } = await requirePermission(ctx, "organisation:manage");
      return ctx.services.organisations.update(
        requireViewer(ctx).id,
        tenant,
        input,
      );
    },
  },
  Organisation: {
    id: (organisation) => organisation.id,
    // The viewer's role in THIS organisation, never the request's scope.
    viewerPermissions: async (organisation, _, ctx) => [
      ...ctx.access.permissionsOf(await ctx.memberships.in(organisation.id)),
    ],
  },
  MyOrganisation: {
    permissions: ({ role }, _, ctx) => [...ctx.access.permissionsOf(role)],
  },
};
