import { toObjectId } from "@softistx/mongo";
import DataLoader from "dataloader";
import { grouped } from "../../../core/shared/ids";
import type { IssueDocument } from "../../issues/public";
import type { IntakeMongo } from "../intake.types";

// The issues a report is linked to, in the order they were linked, per
// request: keys are report ids, and the reports of one page share two grouped
// reads (the links, then their issues). `mongoOf` runs the inbox guard (once
// per batch). Not cached: a link is made or removed during a request.
export const linksLoader = (mongoOf: () => Promise<IntakeMongo>) =>
  new DataLoader<string, IssueDocument[]>(
    async (ids) => {
      const mongo = await mongoOf();
      const links = await mongo.db.clientReportLinks.findMany({
        filter: { reportId: { $in: ids.map((id) => toObjectId(id)) } },
        sort: { _id: 1 },
        limit: 10_000,
      });
      const issues = await mongo.db.issues.findMany({
        filter: { _id: { $in: links.map((link) => link.issueId) } },
        limit: 10_000,
      });
      const byId = new Map(issues.map((issue) => [issue.id, issue]));
      return grouped(ids, links, (link) => link.reportId.toHexString()).map(
        (own) =>
          own.flatMap((link) => byId.get(link.issueId.toHexString()) ?? []),
      );
    },
    { cache: false },
  );
