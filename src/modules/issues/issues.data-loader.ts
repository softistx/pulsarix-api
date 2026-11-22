import { toObjectId } from "@softistx/mongo";
import DataLoader from "dataloader";
import type { IssueProgress } from "@/generated/graphql/resolvers";
import { grouped } from "../../core/shared/ids";
import { progressOf } from "./issues.rules";
import type { IssuesMongo } from "./issues.types";

// The progress of issues, per request: an issue list asks for many at once, so
// a page is two reads (the children, then their statuses), not two per issue.
// `mongoOf` runs the read guard (once per batch). Keys are issue ids.
export function issuesLoaders(mongoOf: () => Promise<IssuesMongo>) {
  return {
    progress: new DataLoader<string, IssueProgress>(async (ids) => {
      const mongo = await mongoOf();
      const children = await mongo.db.issues.findMany({
        filter: { parentId: { $in: ids.map((id) => toObjectId(id)) } },
      });
      const statuses = await mongo.db.statuses.findMany({
        filter: { _id: { $in: children.map((child) => child.statusId) } },
      });
      const category = new Map(
        statuses.map((status) => [status.id, status.category]),
      );
      return grouped(
        ids,
        children,
        (child) => child.parentId?.toHexString() ?? "",
      ).map((own) =>
        progressOf(
          own.map((child) => category.get(child.statusId.toHexString()) ?? ""),
        ),
      );
    }),
  };
}
