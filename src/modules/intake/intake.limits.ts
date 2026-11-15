import { defineRateLimit } from "@softistx/redis";

// The rate limits of the public endpoint (plan §11). Every export is one
// (src/config/redis.ts wires them all, under the `pulsarix` prefix). Windows
// are in milliseconds. The client address comes from `TRUSTED_PROXIES`
// (src/http/context.ts), never from a header the client chose.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Submits of one key, whoever sends them.
export const intakeKey = defineRateLimit({
  name: "intake.key",
  key: (p: { publicKey: string }) => p.publicKey,
  limit: 60,
  per: HOUR,
});

// Submits of one address through one key.
export const intakeIpKey = defineRateLimit({
  name: "intake.ip-key",
  key: (p: { ip: string; publicKey: string }) => `${p.ip}/${p.publicKey}`,
  limit: 5,
  per: 10 * MINUTE,
});

// Submits naming one e-mail address (`emailDigest`).
export const intakeEmail = defineRateLimit({
  name: "intake.email",
  key: (p: { digest: string }) => p.digest,
  limit: 3,
  per: HOUR,
});

// The ceiling of one organisation, all its keys together.
export const intakeOrganisation = defineRateLimit({
  name: "intake.organisation",
  key: (p: { organisationId: string }) => p.organisationId,
  limit: 300,
  per: HOUR,
});

// Config reads and CORS preflights of one address.
export const intakeReadIp = defineRateLimit({
  name: "intake.read-ip",
  key: (p: { ip: string }) => p.ip,
  limit: 120,
  per: 10 * MINUTE,
});

// Tracking-page reads of one address (the secret has 256 bits; this keeps a
// guesser from hammering the lookup).
export const intakeTrackingIp = defineRateLimit({
  name: "intake.tracking-ip",
  key: (p: { ip: string }) => p.ip,
  limit: 30,
  per: 10 * MINUTE,
});

// The KiB of the files one address sends through one key (a PUT costs its
// ticket's size in KiB, since a limit counts at most 9e12 burst x ms): a
// report is at most 12 MB, so three reports in ten minutes.
export const intakeUploadIpKey = defineRateLimit({
  name: "intake.upload-ip-key",
  key: (p: { ip: string; keyId: string }) => `${p.ip}/${p.keyId}`,
  limit: 36 * 1024,
  per: 10 * MINUTE,
});

// The KiB of the files one key takes, whoever sends them.
export const intakeUploadKey = defineRateLimit({
  name: "intake.upload-key",
  key: (p: { keyId: string }) => p.keyId,
  limit: 240 * 1024,
  per: HOUR,
});
