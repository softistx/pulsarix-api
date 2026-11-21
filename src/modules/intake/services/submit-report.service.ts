import { ObjectId } from "mongodb";
import { attachmentsDisabled, keyDisabled, tooFast } from "../intake.errors";
import { trackingMail } from "../intake.mail";
import type { Caller, Submitted } from "../intake.types";
import type { ClientReportDocument, WidgetKeyDocument } from "../models";
import { type CheckedFile, checkFiles } from "../rules/files-input.rules";
import {
  checkMetadata,
  MIN_FILL_MS,
  refused,
  type SubmitInput,
  type SubmittedReport,
  submitInput,
} from "../rules/submit-input.rules";
import { attachmentsOn } from "../utils/attachments.utils";
import { newReportFields, reporterEmailOf } from "../utils/reports.utils";
import { emailDigest, newTrackingToken } from "../utils/token.utils";
import { identifyCaller, sealTrackingToken } from "./identity.service";
import { decoyTickets, reserveSlots, ticketExpiry } from "./slots.service";
import type { PublicIntake } from "./submit.service";

// Every declared file is checked before anything is made (plan §17, A12); a
// refusal is counted on the key (A13).
function checkedFilesOf(
  intake: PublicIntake,
  key: WidgetKeyDocument,
  declared: SubmitInput["files"],
): CheckedFile[] {
  const files = declared ?? [];
  try {
    if (files.length > 0 && !attachmentsOn(key)) throw attachmentsDisabled();
    return checkFiles(files);
  } catch (error) {
    intake.countRefusal(key._id, error);
    throw error;
  }
}

async function limitReporter(
  intake: PublicIntake,
  key: WidgetKeyDocument,
  email: string | null,
) {
  if (email) {
    await intake.limit((l) => l.intakeEmail, { digest: emailDigest(email) });
  }
  await intake.limit((l) => l.intakeOrganisation, {
    organisationId: key.organisationId.toHexString(),
  });
}

// The e-mail that tells the reporter where to follow the report.
function mailTracking(
  intake: PublicIntake,
  created: ClientReportDocument,
  email: string,
  token: string,
  projectName: string,
) {
  intake.background(async () => {
    await intake.deps.mailer.send({
      from: intake.deps.from,
      to: { name: email, address: email },
      ...trackingMail({
        locale: created.locale,
        projectName,
        link: `${intake.deps.uiOrigin}/track/${token}`,
      }),
    });
  });
}

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
