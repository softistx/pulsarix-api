import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { goodReport, type IntakeKit, intakeKit } from "~/intake";
import { coreMongo, tenancy } from "../src/config/db";
import { SYSTEM_ACTOR } from "../src/core/shared/actors";
import {
  IDENTITY_HEADER,
  reporterKeyOf,
} from "../src/modules/intake/services/identity.service";
import { postMessage } from "../src/modules/intake/services/messages.service";
import type { IntakeMongo } from "../src/modules/intake/services/submit.service";
import {
  ownedReport,
  readThread,
} from "../src/modules/intake/services/thread.service";

export const Generate = `mutation($keyId: ID!) {
  generateWidgetIdentitySecret(keyId: $keyId) { secret }
}`;
export const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id issueId } }`;
export const Link = `mutation($id: ID!, $issueId: ID!) {
  linkClientReport(id: $id, issueId: $issueId) { id issueId }
}`;
export const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id }
}`;
export const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
export const EditComment = `mutation($id: ID!, $input: EditCommentInput!) {
  editComment(id: $id, input: $input) { id }
}`;
export const DeleteComment = `mutation($id: ID!) { deleteComment(id: $id) }`;
export const Comments = `query($issueId: ID!) {
  comments(issueId: $issueId) {
    nodes { id body public source reportId reporterName authorId }
  }
}`;
export const IssueFlag = `query($key: String!) { issue(key: $key) { id clientWaiting } }`;
export const ReportFlag = `query($projectId: ID!) {
  clientReports(projectId: $projectId) { nodes { id clientWaiting } }
}`;
export const Watch = `mutation($id: ID!) { watchIssue(id: $id) { id } }`;
export const Notifications = `query { notifications(first: 20) { nodes { kind issueKey } } }`;
export const Journal = `query($issueId: ID!) { activity(issueId: $issueId) { nodes { verb } } }`;

export const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

// A host that signs its users' tokens with the key's identity secret.
export async function host(kit: IntakeKit) {
  const secret = (
    await kit.asOwner.call<{
      generateWidgetIdentitySecret: { secret: string };
    }>(Generate, { keyId: kit.key.id })
  ).generateWidgetIdentitySecret.secret;
  const token = (sub: string) => {
    const iat = Math.floor(Date.now() / 1000);
    const body = b64(
      JSON.stringify({
        sub,
        name: sub,
        aud: kit.key.publicKey,
        iat,
        exp: iat + 3600,
      }),
    );
    return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
  };
  const file = async (sub: string) => {
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
    const { body } = await kit.submit(goodReport({ title: `By ${sub}` }), {
      [IDENTITY_HEADER]: token(sub),
    });
    const data = body?.data as unknown as {
      submitClientReport: { reportId: string };
    };
    return data.submitClientReport.reportId;
  };
  return { file };
}

export async function world() {
  const kit = await intakeKit();
  const mongo = (await tenancy.databaseOf(kit.organisation.id)).as(
    SYSTEM_ACTOR,
  ) as unknown as IntakeMongo;
  const key = await coreMongo.db.widgetKeys.findFirst({
    publicKey: kit.key.publicKey,
  });
  if (!key) throw new Error("no key");
  const reporter = (sub: string) => ({
    keyId: key._id,
    reporterKey: reporterKeyOf(key.id, sub),
  });
  const reportOf = (id: string) =>
    mongo.db.clientReports.findById(new ObjectId(id)) as Promise<never>;
  const say = async (sub: string, id: string, body: string, files = []) =>
    postMessage(
      kit.intake,
      mongo,
      key,
      await ownedReport(mongo, reporter(sub), id),
      { body, files },
    );
  const comment = (issueId: string, body: string, isPublic: boolean) =>
    kit.asOwner.call<{ addComment: { id: string } }>(AddComment, {
      issueId,
      input: { body, public: isPublic },
    });
  const thread = async (sub: string, id: string) =>
    readThread(mongo, await ownedReport(mongo, reporter(sub), id));
  return {
    kit,
    mongo,
    key,
    reporter,
    reportOf,
    say,
    comment,
    thread,
    host: await host(kit),
  };
}
