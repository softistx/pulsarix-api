import { attachmentsDisabled } from "../intake.errors";
import { trackingMail } from "../intake.mail";
import type { ClientReportDocument, WidgetKeyDocument } from "../models";
import { type CheckedFile, checkFiles } from "../rules/files-input.rules";
import type { SubmitInput } from "../rules/submit-input.rules";
import type { PublicIntake } from "../services/submit.service";
import { attachmentsOn } from "./attachments.utils";
import { emailDigest } from "./token.utils";

// Every declared file is checked before anything is made (plan §17, A12); a
// refusal is counted on the key (A13).
export function checkedFilesOf(
  intake: Pick<PublicIntake, "countRefusal">,
  key: Pick<WidgetKeyDocument, "_id" | "attachmentsEnabled">,
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

// What a submission spends before anything is made: one unit on the reporter's
// e-mail (when there is one) and one on the key's organisation.
export async function limitReporter(
  intake: Pick<PublicIntake, "limit">,
  key: Pick<WidgetKeyDocument, "organisationId">,
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
export function mailTracking(
  intake: Pick<PublicIntake, "background" | "deps">,
  created: Pick<ClientReportDocument, "locale">,
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
