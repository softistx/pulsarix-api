import { defineCollection, id, objectId } from "@softistx/mongo";
import { z } from "zod";
import { roles } from "../access";
import { accountId, actors } from "../shared/actors";

const invitationStatus = z.enum(["PENDING", "ACCEPTED", "REVOKED"]);

// An organisation's invitation of a person to join it with a role, by e-mail,
// in the core database. The token of its link is in the mail alone; this keeps
// its sha256. It is accepted once, while PENDING and before `expiresAt` (7
// days); inviting the same address again replaces the pending one. The
// account is made, or found, when the invitation is accepted. `acceptedBy` is
// the account that accepted it.
export const invitations = defineCollection({
  name: "invitations",
  schema: z.object({
    _id: id(),
    organisationId: objectId(),
    email: z.email(),
    // How the invitee is greeted, and what a new account is called.
    name: z.string().trim().min(1).max(200),
    role: z.enum(roles),
    // The language of the mail.
    locale: z.enum(["en", "fr"]),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.date(),
    status: invitationStatus,
    acceptedBy: accountId.nullable().default(null),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    {
      key: { tokenHash: 1 },
      unique: true,
      name: "invitations_tokenUnique",
    },
    // One pending invitation per address and organisation, whatever races.
    {
      key: { organisationId: 1, email: 1 },
      unique: true,
      partialFilterExpression: { status: "PENDING" },
      name: "invitations_onePending",
    },
    {
      key: { organisationId: 1, status: 1, _id: -1 },
      name: "invitations_list",
    },
  ],
});
