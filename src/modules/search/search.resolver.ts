import type { Permission } from "@alxia/access";
import type { Resolvers } from "@/generated/graphql/resolvers";
import {
  can,
  requireMember,
  requirePermission,
  requireViewer,
} from "../../core/access";
import { invalid } from "../../core/shared/errors";
import type { Context } from "../../http/context";
import { searchIssues } from "./search.issues";
import { searchMembers } from "./search.members";
import { searchProjects } from "./search.projects";
import { MAX_FIRST, MAX_QUERY } from "./search.service";

type Kind = "issue" | "project" | "member";

// What reading each kind needs: the permission of the module that owns it.
const needs: Record<Kind, Permission> = {
  issue: "issue:read",
  project: "project:read",
  member: "member:read",
};
const everyKind = Object.keys(needs) as Kind[];

// The kinds to search: the ones asked for, each of which the viewer must hold
// the permission of (403 otherwise), or every kind the viewer may read.
async function allowed(
  ctx: Context,
  asked: readonly Kind[] | null | undefined,
) {
  if (asked && asked.length > 0) {
    for (const kind of new Set(asked))
      await requirePermission(ctx, needs[kind]);
    return new Set(asked);
  }
  const held = new Set<Kind>();
  for (const kind of everyKind) if (await can(ctx, needs[kind])) held.add(kind);
  return held;
}

export const searchResolvers: Resolvers = {
  Query: {
    search: async (_, args, ctx) => {
      const { mongo, tenant } = await requireMember(ctx);
      const viewer = requireViewer(ctx);
      const query = args.query.trim();
      const first = args.first ?? 10;
      if (query.length === 0 || query.length > MAX_QUERY) {
        throw invalid([{ path: "query", code: "validation.errors.invalid" }]);
      }
      if (!Number.isInteger(first) || first < 1 || first > MAX_FIRST) {
        throw invalid([
          { path: "first", code: "validation.errors.out-of-range" },
        ]);
      }
      const kinds = await allowed(ctx, args.kinds);
      const [issues, projects, members] = await Promise.all([
        kinds.has("issue") ? searchIssues(mongo, query, first) : [],
        kinds.has("project") ? searchProjects(mongo, query, first) : [],
        kinds.has("member")
          ? ctx.services
              .members(tenant, viewer.id)
              .list()
              .then((all) => searchMembers(all, query, first))
          : [],
      ]);
      return { issues, projects, members } as never;
    },
  },
};
