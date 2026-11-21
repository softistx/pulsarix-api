import type { ObjectId } from "mongodb";
import type { CoreMongo } from "../../../config/db";

// The reasons a widget key counts a refusal under (A13): the file traffic's
// refusals, by the slug of their code (`intake.errors.<slug>`). A closed list,
// so a caller cannot grow a key's document with names of its own; any other
// refusal (a foreign origin, an unknown key, a 500) is not counted.
export const refusalReasons = [
  "attachments-disabled",
  "too-many-files",
  "files-too-large",
  "file-unsupported-type",
  "file-undecodable",
  "file-too-large",
  "file-too-many-pixels",
  "quarantine-full",
  "ticket-invalid",
  "ticket-expired",
  "ticket-used",
  "upload-mismatch",
  "too-many-requests",
] as const;
export type RefusalReason = (typeof refusalReasons)[number];

const PREFIX = "intake.errors.";

// The countable reason of an error code, or null.
export function reasonOf(code: unknown): RefusalReason | null {
  if (typeof code !== "string" || !code.startsWith(PREFIX)) return null;
  const slug = code.slice(PREFIX.length);
  return (refusalReasons as readonly string[]).includes(slug)
    ? (slug as RefusalReason)
    : null;
}

type KeysCollection = Pick<CoreMongo, "db">["db"]["widgetKeys"];

// One more file stored on the key, or one more refusal under `reason`.
export async function countOnKey(
  keys: Pick<KeysCollection, "raw">,
  keyId: ObjectId,
  what: { upload: true } | { refusal: RefusalReason },
) {
  await keys.raw.updateOne(
    { _id: keyId },
    {
      $inc:
        "upload" in what ? { uploads: 1 } : { [`refusals.${what.refusal}`]: 1 },
    },
  );
}
