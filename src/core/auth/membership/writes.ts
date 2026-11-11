import type { createMongoAdapter } from "@softistx/janus-mongo";
import { relationOf, roles } from "../../access";
import { organizationObject, subjectOf } from "./reads";
import type { JanusMembership } from "./types";

type Relations = ReturnType<typeof createMongoAdapter>["relations"];

// A role is changed in one `relations.write` (all or nothing): the new role
// added and the others removed together, so a half-done `assign` cannot
// exist. Concurrent changes of one organisation's members are serialised by the
// members module (its lock document), which owns the last-owner rule.
type Writes = Pick<JanusMembership, "assign" | "remove">;

export function membershipWrites(relations: Relations): Writes {
  const tuple = (
    organizationId: string,
    accountId: string,
    relation: string,
  ) => ({
    object: organizationObject(organizationId),
    relation,
    subject: subjectOf(accountId),
  });
  return {
    assign: (organizationId, accountId, role) =>
      relations.write({
        remove: roles
          .filter((other) => other !== role)
          .map((other) => tuple(organizationId, accountId, relationOf(other))),
        add: [tuple(organizationId, accountId, relationOf(role))],
      }),
    remove: (organizationId, accountId) =>
      relations.write({
        remove: roles.map((role) =>
          tuple(organizationId, accountId, relationOf(role)),
        ),
      }),
  };
}
