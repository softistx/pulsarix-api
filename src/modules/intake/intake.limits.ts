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

// One use per decoy ticket (a bot's, whose PUT stores nothing): the limit
// stands in for the slot a real ticket has, so a replayed decoy is a 409 like
// a replayed real ticket. The window is the ticket's life.
export const intakeDecoySlot = defineRateLimit({
  name: "intake.decoy-slot",
  key: (p: { slot: string }) => p.slot,
  limit: 1,
  per: 15 * MINUTE,
});

// Reports of one identified reporter through one key (the key id and the
// `reporterKey`, plan §19). Shorter than the address limit: a signed-in user
// who changes address is still one reporter.
export const intakeReporter = defineRateLimit({
  name: "intake.reporter",
  key: (p: { keyId: string; reporterKey: string }) =>
    `${p.keyId}/${p.reporterKey}`,
  limit: 10,
  per: 10 * MINUTE,
});

// The reads of one identified reporter through one key: the lists, a request,
// the read marks, the e-mail switch and every open of the live stream (plan §19).
export const intakeReporterRead = defineRateLimit({
  name: "intake.reporter-read",
  key: (p: { keyId: string; reporterKey: string }) =>
    `${p.keyId}/${p.reporterKey}`,
  limit: 120,
  per: 10 * MINUTE,
});

// The replies of one identified reporter through one key.
export const intakeReporterReply = defineRateLimit({
  name: "intake.reporter-reply",
  key: (p: { keyId: string; reporterKey: string }) =>
    `${p.keyId}/${p.reporterKey}`,
  limit: 10,
  per: 10 * MINUTE,
});

// The replies one key takes, whoever sends them: a ceiling against a host that
// signs tokens for a crowd.
export const intakeKeyReply = defineRateLimit({
  name: "intake.key-reply",
  key: (p: { keyId: string }) => p.keyId,
  limit: 600,
  per: HOUR,
});

// "Mark as resolved" and "Reopen" of one identified reporter.
export const intakeReporterSettle = defineRateLimit({
  name: "intake.reporter-settle",
  key: (p: { keyId: string; reporterKey: string }) =>
    `${p.keyId}/${p.reporterKey}`,
  limit: 20,
  per: 24 * HOUR,
});

// "Delete my data": once an hour per reporter.
export const intakeReporterErase = defineRateLimit({
  name: "intake.reporter-erase",
  key: (p: { keyId: string; reporterKey: string }) =>
    `${p.keyId}/${p.reporterKey}`,
  limit: 1,
  per: HOUR,
});
