import type { MediaBucket } from "@softistx/alxia-media";
import { mediaPlace } from "@softistx/alxia-media";
import { type BoundBucket, bindBucket, defineBucket } from "@softistx/s3";
import { kindName, previewSize } from "./attachments.kinds";

// The one private bucket the files live in. The layout of a key
// (`organisations/<id>/attachments/<key>[/<size>.webp]`) is @softistx/alxia-media's,
// given the tenant prefix of routes/guard.routes.ts.
// `list` is for the sweeps by prefix (an organisation's whole folder); the
// routes need only what MediaBucket names.
export interface Media {
  bucket: MediaBucket & Pick<BoundBucket<{ key: string }>, "list">;
}

export interface MediaOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | undefined;
  region?: string | undefined;
}

// `bindBucket` talks to nothing until a call. No `acl` is bound: objects are
// never public and nothing here signs a URL for a browser.
export function createMedia(options: MediaOptions): Media {
  const { bucket, endpoint, region, accessKeyId, secretAccessKey } = options;
  const bound = bindBucket(
    defineBucket({ bucket, key: (p: { key: string }) => p.key }),
    {
      accessKeyId,
      secretAccessKey,
      ...(endpoint !== undefined && { endpoint, virtualHostedStyle: false }),
      ...(region !== undefined && { region }),
      // The deadline of every call; past it the call fails and the routes
      // answer 503.
      timeoutMs: 10_000,
    },
  );
  return { bucket: bound };
}

// The bucket keys of one file and its thumbnail, in the organisation's folder.
export const placeIn = (organisationId: string) =>
  mediaPlace(kindName, folderOf(organisationId), "webp");
export const folderOf = (organisationId: string) =>
  `organisations/${organisationId}`;

// What deleting a record must also remove from the bucket.
export function objectKeys(
  organisationId: string,
  file: { storageKey: string; previewKey: string | null },
): string[] {
  const place = placeIn(organisationId);
  return [
    place(file.storageKey),
    ...(file.previewKey ? [place(file.storageKey, previewSize)] : []),
  ];
}

// The bucket the record deletions purge, bound by `createApp` (the change
// handlers of an issue or a comment know no request). A process runs one app,
// so one bucket; an app without a store leaves the bound one alone (a spec
// builds several apps). With none bound nothing is purged and the objects stay
// for a sweep to find.
let current: Media | undefined;
export const useMedia = (media: Media | undefined) => {
  if (media) current = media;
};

// Removes the objects of deleted records, each failure ignored: the records
// are gone already and a missed object is only an orphan.
export async function purge(keys: readonly string[]) {
  const media = current;
  if (!media) return;
  await Promise.allSettled(keys.map((key) => media.bucket.delete({ key })));
}
