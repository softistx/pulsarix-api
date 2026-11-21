import { ObjectId } from "mongodb";
import {
  attachmentsDisabled,
  keyDisabled,
  originNotAllowed,
  quarantineFull,
  ticketExpired,
  ticketInvalid,
  ticketUsed,
  unknownKey,
} from "../intake.errors";
import type { Admission, Caller, IntakeMongo } from "../intake.types";
import { originAllowed } from "../rules/origins.rules";
import { checkAnnounced, QUARANTINE_BYTES } from "../rules/uploads.rules";
import { attachmentsOn } from "../utils/attachments.utils";
import { readTicket, type TicketClaims } from "../utils/tickets.utils";
import { releaseFiles } from "./files-team.service";
import type { PublicIntake } from "./submit.service";

// An upload takes its slot for this long; a failed one gives it back at once.
const CLAIM_MS = 60_000;

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
    if (claims.tracking) {
      // The tracking page's ticket: the UI server's PUT, never a browser's.
      if (caller.origin !== null) throw originNotAllowed();
    } else {
      if (!originAllowed(caller.origin, key.allowedOrigins)) {
        throw originNotAllowed();
      }
      caller.originGranted = true;
    }
    if (!key.active) throw keyDisabled();
    if (!attachmentsOn(key)) throw attachmentsDisabled();
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
    // Pending slots count toward the cap on purpose (decision of #142): a
    // submit that announces files without sending them reserves its bytes
    // until the ticket expires (15 minutes, PENDING_SLOT_MINUTES), so in-flight
    // PUTs can never overrun the quota. The abuse this allows is bounded by
    // that expiry and the submit limits.
    // The sum already holds this slot (it is pending), so the incoming file is
    // counted once. The sum and the claim below are two steps: concurrent PUTs
    // of different slots can each pass the check and overshoot the cap by the
    // files in flight; the cap is a bound on what is admitted, not a lock.
    if ((await this.quarantineHeld(files)) > QUARANTINE_BYTES) {
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

  // The bytes an organisation's quarantine holds now, pending slots included: a
  // sum over the `state, size` index (clientReportFiles_stateSize), which covers
  // the query without reading the documents.
  private async quarantineHeld(
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
    await this.keep(mongo, claims, stored, dimensions);
    // The report may have been accepted between the read in `keep` and the
    // write: look again, so a file never stays quarantined on an accepted report.
    const now = await mongo.db.clientReports.findById(
      new ObjectId(claims.reportId),
    );
    if (now?.state === "accepted" || now?.state === "closed")
      await releaseFiles(mongo, new ObjectId(claims.reportId));
    this.intake.countUpload(new ObjectId(claims.keyId));
    this.announce(admission);
  }

  // The slot becomes a quarantined file (released at once when its report was
  // accepted meanwhile: the report's files are on its issue).
  private async keep(
    mongo: IntakeMongo,
    claims: TicketClaims,
    stored: { key: string; contentType: string; sizes: readonly string[] },
    dimensions: { width: number; height: number } | undefined,
  ) {
    const report = await mongo.db.clientReports.findById(
      new ObjectId(claims.reportId),
    );
    // The report's issue was deleted while this file was on its way: the file
    // carries a removal date at once, so the retention job purges it.
    const orphaned =
      report?.state === "closed" &&
      report.issueId !== undefined &&
      report.issueId !== null &&
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
  }

  // The inbox hears of the file. A reply's file reaches the team with its
  // message, not as an inbox file.
  private announce(admission: Admission) {
    const { intake } = this;
    const { claims, role } = admission;
    const publish = intake.deps.publishFile;
    if (!publish || !role || role === "reply") return;
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
