import { mediaPlace } from "@alxia/media";
import type { Media } from "../attachments/public";
import { fileKindName, previewSize } from "./intake.files.kinds";

// The layout of a report file's objects (@alxia/media's, given the tenant
// prefix): `organisations/<id>/report-files/<key>/<size>`. A picture has `full`
// and `256`; a PDF is the kind's original, at `<key>` itself (served as
// `/file`), beside its `256` preview.
export const organisationFolder = (organisationId: string) =>
  `organisations/${organisationId}`;
export const placeOf = (organisationId: string) =>
  mediaPlace(fileKindName, organisationFolder(organisationId));

const sizes = ["full", previewSize] as const;

// Every object a file's key can name, the ones it does not have included
// (deleting a missing object is not an error).
export function fileObjectKeys(organisationId: string, storageKey: string) {
  const place = placeOf(organisationId);
  return [place(storageKey), ...sizes.map((size) => place(storageKey, size))];
}

// Removes `keys`, each failure counted instead of thrown: the records are gone
// already, and a missed object is reported so the caller can retry (an object
// no record names is swept by the organisation prefix).
export async function removeObjects(media: Media, keys: readonly string[]) {
  const results = await Promise.allSettled(
    keys.map((key) => media.bucket.delete({ key })),
  );
  return results.filter((result) => result.status === "rejected").length;
}

// Removes every object under `organisations/<id>/` (all of the organisation's
// kinds), for the deletion of an organisation. Answers how many objects it
// removed; a failure is thrown, so the caller retries.
export async function purgeOrganisationFiles(
  media: Media,
  organisationId: string,
) {
  const prefix = `${organisationFolder(organisationId)}/`;
  let removed = 0;
  let cursor: string | null = null;
  do {
    const page = await media.bucket.list({ prefix, cursor });
    await Promise.all(
      page.items.map((item) => media.bucket.delete({ key: item.key })),
    );
    removed += page.items.length;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return removed;
}
