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
// (read limit), the ticket (signature, slot, deadline), the key (live, the
// `Origin` in its list, files on), the announced type and length, the byte
// limits, the slot (pending, not taken), the organisation's quarantine, the
// claim. Each refusal comes before a byte of the body is read.
export class ReportUploads {
  constructor(private readonly intake: PublicIntake) {}

  async admit(
    slot: string,
    ticket: string | null,
    upload: { contentType: string | null; length: string | null },
    caller: Caller,
  ): Promise<Admission> {
    const { intake } = this;
    const { deps } = intake;
    await intake.guardAddress(caller.ip);
    const claims = ticket ? readTicket(deps.ticketSecret, ticket) : null;
    if (!claims || claims.slot !== slot) throw ticketInvalid();
    const key = await deps.core.db.widgetKeys.findFirst({
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
    const now = intake.now();
    if (claims.expiresAt <= now.getTime()) throw ticketExpired();

    // The announced type and length are the ticket's, exactly.
    if (essenceOf(upload.contentType) !== claims.type) {
      throw uploadMismatch();
    }
    const declared = /^\d{1,10}$/.test(upload.length ?? "")
      ? Number(upload.length)
      : null;
    if (declared === null) throw uploadMismatch();
    if (declared > claims.size) throw fileTooLarge(maxFileBytes);
    if (declared !== claims.size) throw uploadMismatch();

    // A decoy is a genuine-looking slot with nothing behind it.
    if (claims.decoy) {
      return {
        claims,
        decoy: true,
        mongo: null,
        projectId: key.projectId.toHexString(),
        role: null,
      };
    }

    await intake.limit(
      (l) => l.intakeUploadIpKey,
      { ip: caller.ip, keyId: claims.keyId },
      Math.ceil(claims.size / 1024),
    );
    await intake.limit(
      (l) => l.intakeUploadKey,
      { keyId: claims.keyId },
      Math.ceil(claims.size / 1024),
    );

    const mongo = await intake.databaseOf(key);
    const files = mongo.db.clientReportFiles;
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

    const held = (await files.raw
      .aggregate([
        { $match: { state: { $in: ["pending", "quarantined"] } } },
        { $group: { _id: null, bytes: { $sum: "$size" } } },
      ])
      .toArray()) as Array<{ bytes: number }>;
    // The incoming file counts too, so a racing PUT cannot overshoot the cap.
    if ((held[0]?.bytes ?? 0) + claims.size > QUARANTINE_BYTES) {
      throw quarantineFull();
    }

    // One upload at a time: the first takes the slot, a replay finds it taken.
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
    return {
      claims,
      decoy: false,
      mongo,
      projectId: key.projectId.toHexString(),
      role: file.role,
    };
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
          expiresAt: null,
          claimedAt: null,
          updatedAt: new Date(),
        },
      },
    );
    if (done.matchedCount === 0) throw ticketExpired();
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
