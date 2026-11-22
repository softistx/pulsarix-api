import { ObjectId } from "mongodb";
import { keyDisabled, tooFast } from "../intake.errors";
import { announceRequests, requestsOf } from "../intake.live";
import type { Caller, Submitted } from "../intake.types";
import type { ClientReportDocument, WidgetKeyDocument } from "../models";
import type { CheckedFile } from "../rules/files-input.rules";
import {
  checkMetadata,
  MIN_FILL_MS,
  refused,
  type SubmitInput,
  type SubmittedReport,
  submitInput,
} from "../rules/submit-input.rules";
import { newReportFields, reporterEmailOf } from "../utils/reports.utils";
import {
  checkedFilesOf,
  limitReporter,
  mailTracking,
} from "../utils/submit.utils";
import { newTrackingToken } from "../utils/token.utils";
import { identifyCaller, sealTrackingToken } from "./identity.service";
import { decoyTickets, reserveSlots, ticketExpiry } from "./slots.service";
import type { PublicIntake } from "./submit.service";

// The report, its tickets and what follows it (the live event, the e-mail).
async function fileReport(
  intake: PublicIntake,
  key: WidgetKeyDocument,
  input: {
    report: SubmittedReport;
    email: string | null;
    files: CheckedFile[];
    caller: Caller;
    identity: Awaited<ReturnType<typeof identifyCaller>>;
  },
): Promise<Submitted> {
  const { report, email, files, caller, identity } = input;
  const metadata = report.metadata ?? [];
  checkMetadata(metadata);
  const mongo = await intake.databaseOf(key);
  const project = await mongo.db.projects.findById(key.projectId);
  if (!project || project.archivedAt) throw keyDisabled();
  const organisationId = key.organisationId.toHexString();
  const tracking = email ? newTrackingToken(organisationId) : null;
  const created: ClientReportDocument = await mongo.db.clientReports.create(
    newReportFields({
      key,
      report,
      email,
      identity,
      caller,
      metadata,
      tracking: tracking
        ? {
            hash: tracking.hash,
            sealed: sealTrackingToken(tracking.token, key.id),
          }
        : null,
    }),
  );
  intake.touch(key);
  const tickets = await reserveSlots(
    intake.deps.ticketSecret,
    mongo,
    key,
    created,
    files,
    ticketExpiry(intake.now()),
  );
  intake.background(async () => {
    await intake.deps.publish({
      organisationId,
      projectId: key.projectId.toHexString(),
      reportId: created.id,
      title: created.title,
      at: created.createdAt.toISOString(),
    });
  });
  intake.background(
    announceRequests(requestsOf(organisationId, [created], "new"), () =>
      intake.now(),
    ),
  );
  if (email && tracking) {
    mailTracking(intake, created, email, tracking.token, project.name);
  }
  return { reportId: created.id, tracking: !!email, files: tickets };
}

// The widget's submission. A bot that fills the hidden field is told it
// worked, and nothing is kept: its tickets are decoys, signed like the others,
// whose PUT stores nothing (and which, like a real one, can be used once).
export async function submitReport(
  intake: PublicIntake,
  publicKey: string,
  given: SubmitInput,
  caller: Caller,
): Promise<Submitted> {
  const key = await intake.admit(publicKey, caller);
  await intake.limit((l) => l.intakeIpKey, { ip: caller.ip, publicKey });
  await intake.limit((l) => l.intakeKey, { publicKey });
  if (!key.active) throw keyDisabled();
  const identity = await identifyCaller(intake, key, caller.identity);
  const parsed = submitInput.safeParse(given);
  if (!parsed.success) refused(parsed.error);
  const report = parsed.data;
  const email = reporterEmailOf(identity, report);
  await limitReporter(intake, key, email);
  const files = checkedFilesOf(intake, key, report.files);
  if (report.website) {
    const reportId = new ObjectId().toHexString();
    const expiry = ticketExpiry(intake.now());
    const decoys = decoyTickets(
      intake.deps.ticketSecret,
      key,
      reportId,
      files,
      expiry,
    );
    return { reportId, tracking: !!email, files: decoys };
  }
  if (report.filledInMs < MIN_FILL_MS) throw tooFast();
  return fileReport(intake, key, { report, email, files, caller, identity });
}
