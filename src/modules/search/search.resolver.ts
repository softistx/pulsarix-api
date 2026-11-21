import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember, requireViewer } from "../../core/access";
import { invalid } from "../../core/shared/errors";
import { allowed, MAX_FIRST, MAX_QUERY, searchMembers } from "./search.utils";
import { searchIssues, searchProjects } from "./services";

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
