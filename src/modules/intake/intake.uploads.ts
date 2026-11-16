import { ObjectId } from "mongodb";
import {
  attachmentsDisabled,
  fileTooLarge,
  keyDisabled,
  originNotAllowed,
  quarantineFull,
  ticketExpired,
  ticketInvalid,
  ticketUsed,
  unknownKey,
  uploadMismatch,
} from "./intake.errors";
import { maxFileBytes } from "./intake.files.kinds";
import { releaseFiles } from "./intake.files.team";
import type { ReportFileRole } from "./intake.model";
import { originAllowed } from "./intake.origins";
import type { Caller, IntakeMongo, PublicIntake } from "./intake.submit";
import { readTicket, type TicketClaims } from "./intake.tickets";

// How much an organisation's quarantine holds, pending slots included: the
// bytes strangers can leave in one organisation's bucket before the team looks.
export const QUARANTINE_BYTES = 512 * 1024 * 1024;
// An upload takes its slot for this long; a failed one gives it back at once.
const CLAIM_MS = 60_000;

// The content type without its parameters, in lower case.
const essenceOf = (type: string | null) =>
  (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

// The bytes an organisation's quarantine holds now, pending slots included: a
// sum over the `state, size` index (clientReportFiles_stateSize), which covers
// the query without reading the documents.
async function quarantineHeld(
  files: IntakeMongo["db"]["clientReportFiles"],
): Promise<number> {
  const held = (await files.raw
    .aggregate([
      { $match: { state: { $in: ["pending", "quarantined"] } } },
      { $group: { _id: null, bytes: { $sum: "$size" } } },
    ])
    .toArray()) as Array<{ bytes: number }>;
  return held[0]?.bytes ?? 0;
}

// The announced type and length are the ticket's, exactly.
function checkAnnounced(
  claims: TicketClaims,
  upload: { contentType: string | null; length: string | null },
) {
  if (essenceOf(upload.contentType) !== claims.type) throw uploadMismatch();
  const declared = /^\d{1,10}$/.test(upload.length ?? "")
    ? Number(upload.length)
    : null;
  if (declared === null) throw uploadMismatch();
  if (declared > claims.size) throw fileTooLarge(maxFileBytes);
  if (declared !== claims.size) throw uploadMismatch();
}

// What the PUT route knows once every check that needs no byte of the body
// has passed.
export interface Admission {
  claims: TicketClaims;
  decoy: boolean;
  mongo: IntakeMongo | null;
  projectId: string;
  role: ReportFileRole | null;
}

// What one upload to a slot is allowed (plan §17, A12), in order: the address
// (read limit), the ticket and its key (`authorise`), the announced type and
// length, the byte limits, the slot (`takeSlot`: pending, the organisation's
// quarantine, the claim). Each refusal comes before a byte of the body is read.
export class ReportUploads {
  constructor(private readonly intake: PublicIntake) {}

  async admit(
    slot: string,
    ticket: string | null,
    upload: { contentType: string | null; length: string | null },
    caller: Caller,
  ): Promise<Admission> {
    const { intake } = this;
    await intake.guardAddress(caller.ip);
    const { claims, key } = await this.authorise(slot, ticket, caller);
    checkAnnounced(claims, upload);
    const projectId = key.projectId.toHexString();
    // A decoy is a genuine-looking slot with nothing behind it.
    if (claims.decoy) {
      await this.useDecoy(claims.slot);
      return { claims, decoy: true, mongo: null, projectId, role: null };
    }
    const cost = Math.ceil(claims.size / 1024);
    await intake.limit(
      (l) => l.intakeUploadIpKey,
      { ip: caller.ip, keyId: claims.keyId },
      cost,
    );
    await intake.limit((l) => l.intakeUploadKey, { keyId: claims.keyId }, cost);
    const mongo = await intake.databaseOf(key);
    const role = await this.takeSlot(mongo, claims);
    return { claims, decoy: false, mongo, projectId, role };
  }

  // The ticket and the key behind it: the signature, the slot, the key (live,
  // the `Origin` in its list, files on) and the deadline.
  private async authorise(slot: string, ticket: string | null, caller: Caller) {
    const { intake } = this;
    const claims = ticket ? readTicket(intake.deps.ticketSecret, ticket) : null;
    if (!claims || claims.slot !== slot) throw ticketInvalid();
    const key = await intake.deps.core.db.widgetKeys.findFirst({
      _id: new ObjectId(claims.keyId),
      organisationId: new ObjectId(claims.organisationId),
      revokedAt: null,
    });
    if (!key) throw unknownKey();
    if (!originAllowed(caller.origin, key.allowedOrigins)) {
      throw originNotAllowed();
    }
    caller.originGranted = true;
    if (!key.active) throw keyDisabled();
    if (!key.attachmentsEnabled) throw attachmentsDisabled();
    if (claims.expiresAt <= intake.now().getTime()) throw ticketExpired();
    return { claims, key };
  }

  // A decoy ticket serves once, as a real one does: the rate limit of its slot
  // stands in for the record (nothing is stored). The replay is a 409 like a
  // real replay, never the 429 the limit itself would answer.
  private async useDecoy(slot: string) {
    try {
      await this.intake.limit((l) => l.intakeDecoySlot, { slot });
    } catch (error) {
      const code = (error as { extensions?: { code?: unknown } }).extensions
        ?.code;
      throw code === "intake.errors.too-many-requests" ? ticketUsed() : error;
    }
  }

  // The slot a real ticket names: pending and not expired, with the size and
  // type the ticket carries, within the organisation's quarantine; then taken,
  // one upload at a time (the first takes it, a replay finds it taken).
  private async takeSlot(mongo: IntakeMongo, claims: TicketClaims) {
    const files = mongo.db.clientReportFiles;
    const now = this.intake.now();
    const file = await files.findFirst({
      _id: new ObjectId(claims.slot),
      reportId: new ObjectId(claims.reportId),
      state: "pending",
    });
    if (!file) throw ticketUsed();
    if (file.size !== claims.size || file.mime !== claims.type) {
      throw ticketInvalid();
    }
    if (file.expiresAt && file.expiresAt <= now) throw ticketExpired();
    // The incoming file counts too, so a racing PUT cannot overshoot the cap.
    if ((await quarantineHeld(files)) + claims.size > QUARANTINE_BYTES) {
      throw quarantineFull();
    }
    const taken = await files.raw.findOneAndUpdate(
      {
        _id: file._id,
        state: "pending",
        $or: [
          { claimedAt: null },
          { claimedAt: { $lte: new Date(now.getTime() - CLAIM_MS) } },
        ],
      },
      { $set: { claimedAt: now } },
    );
    if (!taken) throw ticketUsed();
    return file.role;
  }

  // The upload failed: the slot is free again until its deadline.
  async release(admission: Admission) {
    if (!admission.mongo) return;
    await admission.mongo.db.clientReportFiles.raw.updateOne(
      { _id: new ObjectId(admission.claims.slot), state: "pending" },
      { $set: { claimedAt: null } },
    );
  }

  // The bytes are stored: the slot becomes a quarantined file, and the inbox
  // hears of it. A slot the purge took meanwhile fails this, and the objects
  // are removed by the route.
  async store(
    admission: Admission,
    stored: { key: string; contentType: string; sizes: readonly string[] },
    dimensions: { width: number; height: number } | undefined,
  ) {
    const { mongo, claims } = admission;
    if (!mongo) throw new Error("a decoy stores nothing");
    // A file that arrives after its report was accepted is released at once
    // (the report's files are on its issue).
    const report = await mongo.db.clientReports.findById(
      new ObjectId(claims.reportId),
    );
    // The report's issue was deleted while this file was on its way: the file
    // carries a removal date at once, so the retention job purges it.
    const orphaned =
      report?.state === "closed" &&
      report.issueId != null &&
      !(await mongo.db.issues.findById(report.issueId));
    const done = await mongo.db.clientReportFiles.raw.updateOne(
      { _id: new ObjectId(claims.slot), state: "pending" },
      {
        $set: {
          storageKey: stored.key,
          previewKey: stored.sizes.includes("256") ? "256" : null,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          state:
            report?.state === "accepted" || report?.state === "closed"
              ? "released"
              : "quarantined",
          expiresAt: orphaned ? new Date() : null,
          claimedAt: null,
          updatedAt: new Date(),
        },
      },
    );
    if (done.matchedCount === 0) throw ticketExpired();
    // The report may have been accepted between the read above and the write:
    // look again, so a file never stays quarantined on an accepted report.
    const now = await mongo.db.clientReports.findById(
      new ObjectId(claims.reportId),
    );
    if (now?.state === "accepted" || now?.state === "closed")
      await releaseFiles(mongo, new ObjectId(claims.reportId));
    const { intake } = this;
    intake.countUpload(new ObjectId(claims.keyId));
    const publish = intake.deps.publishFile;
    if (publish && admission.role) {
      const role = admission.role;
      intake.background(async () => {
        await publish({
          organisationId: claims.organisationId,
          projectId: admission.projectId,
          reportId: claims.reportId,
          fileId: claims.slot,
          role,
          at: intake.now().toISOString(),
        });
      });
    }
  }
}
