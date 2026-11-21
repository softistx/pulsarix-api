import { goodReport, intakeKit } from "~/intake";
import { tenancy } from "../src/config/db";
import { SYSTEM_ACTOR } from "../src/core/shared/actors";
import { serverTicketSecret } from "../src/modules/intake/intake.server";
import type {
  ReporterMailDeps,
  ReporterMailJob,
} from "../src/modules/intake/intake.types";
import { useReporterMailQueue } from "../src/modules/intake/services/notify.service";
import { sendReporterMail } from "../src/modules/intake/services/reporter-mail.service";
import type { IntakeMongo } from "../src/modules/intake/services/submit.service";
import { unsubscribeSecret } from "../src/modules/intake/utils/mail.utils";

export const Generate = `mutation($keyId: ID!) {
  generateWidgetIdentitySecret(keyId: $keyId) { secret }
}`;
export const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id issueId } }`;
export const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id }
}`;
export const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
export const Statuses = `query($key: String!) {
  project(key: $key) { statuses { id name category } }
}`;
export const Move = `mutation($id: ID!, $statusId: ID!) { moveIssue(id: $id, statusId: $statusId) { id } }`;

export const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

// A queue that keeps what was added and refuses a second job with the same id,
// as @softistx/redis does for a job that is still waiting.
export function fakeQueue() {
  const jobs = new Map<string, ReporterMailJob>();
  const delays: number[] = [];
  return {
    jobs,
    delays,
    queue: {
      async add(data: ReporterMailJob, options: { id: string; delay: number }) {
        delays.push(options.delay);
        if (jobs.has(options.id)) return { deduplicated: true };
        jobs.set(options.id, data);
        return { deduplicated: false };
      },
    },
  };
}

export async function world() {
  const kit = await intakeKit();
  const fake = fakeQueue();
  const restore = useReporterMailQueue(fake.queue);
  const mongo = (await tenancy.databaseOf(kit.organisation.id)).as(
    SYSTEM_ACTOR,
  ) as unknown as IntakeMongo;
  const deps = (): ReporterMailDeps => ({
    mongo: async () => mongo,
    mailer: kit.mailer,
    from: { name: "pulsarix", address: "noreply@pulsarix.test" },
    uiOrigin: "https://ui.pulsarix.test",
    allowedOrigins: async () => [kit.site],
    secret: unsubscribeSecret(serverTicketSecret()),
  });
  const clearIp = () =>
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
  // A report with an e-mail, accepted into an issue. Mails sent so far are
  // forgotten: the tracking e-mail is not what is under test.
  const accepted = async (extra: Record<string, unknown> = {}) => {
    clearIp();
    const { body } = await kit.submit(
      goodReport({ email: "r@client.test", ...extra }),
    );
    const reportId = (
      body as unknown as {
        data: { submitClientReport: { reportId: string } };
      }
    ).data.submitClientReport.reportId;
    await kit.intake.settled();
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: reportId });
    kit.mailer.clear();
    fake.jobs.clear();
    fake.delays.length = 0;
    return { reportId, issueId: acceptClientReport.issueId };
  };
  const comment = (issueId: string, body: string, isPublic: boolean) =>
    kit.asOwner.call(AddComment, {
      issueId,
      input: { body, public: isPublic },
    });
  const run = (reportId: string) =>
    sendReporterMail(deps(), {
      organisationId: kit.organisation.id,
      reportId,
    });
  return { kit, fake, mongo, deps, accepted, comment, run, restore, clearIp };
}
