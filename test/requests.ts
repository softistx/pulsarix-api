import { expect } from "bun:test";
import { createHmac } from "node:crypto";
import { tenancy } from "../src/config/db";
import { SYSTEM_ACTOR } from "../src/core/shared/actors";
import { LIVE_REQUESTS_PATH } from "../src/modules/intake/intake.http";
import { IDENTITY_HEADER } from "../src/modules/intake/services/identity.service";
import type { IntakeMongo } from "../src/modules/intake/services/submit.service";
import { goodReport, type IntakeKit, intakeKit } from "./intake";

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
export const Watch = `mutation($id: ID!) { watchIssue(id: $id) { id } }`;
export const Notifications = `query { notifications(first: 20) { nodes { kind issueKey } } }`;
export const Journal = `query($issueId: ID!) { activity(issueId: $issueId) { nodes { verb } } }`;

export const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");
export const DAY = 86_400_000;

export type Data = Record<string, Record<string, unknown>>;

export async function world() {
  const kit = await intakeKit();
  const secret = (
    await kit.asOwner.call<{
      generateWidgetIdentitySecret: { secret: string };
    }>(Generate, { keyId: kit.key.id })
  ).generateWidgetIdentitySecret.secret;
  const token = (sub: string, lifetime = 3600) => {
    const iat = Math.floor(Date.now() / 1000);
    const body = b64(
      JSON.stringify({
        sub,
        name: sub,
        aud: kit.key.publicKey,
        iat,
        exp: iat + lifetime,
      }),
    );
    return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
  };
  const mongo = (await tenancy.databaseOf(kit.organisation.id)).as(
    SYSTEM_ACTOR,
  ) as unknown as IntakeMongo;
  const clearIp = () =>
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
  const file = async (sub: string, extra: Record<string, unknown> = {}) => {
    clearIp();
    const { body } = await kit.submit(
      goodReport({ title: `By ${sub}`, ...extra }),
      { [IDENTITY_HEADER]: token(sub) },
    );
    return (
      body as unknown as { data: { submitClientReport: { reportId: string } } }
    ).data.submitClientReport.reportId;
  };
  // A persisted operation as the reporter `sub` makes it.
  const as = (
    sub: string | null,
    id: string,
    variables: Record<string, unknown>,
  ) =>
    kit.op(
      id,
      { publicKey: kit.key.publicKey, ...variables },
      sub === null ? {} : { [IDENTITY_HEADER]: token(sub) },
    );
  const data = async (
    sub: string,
    id: string,
    variables: Record<string, unknown>,
  ) => {
    const { response, body } = await as(sub, id, variables);
    expect(response.status).toBe(200);
    return body?.data as unknown as Data;
  };
  const accept = async (reportId: string) => {
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: reportId });
    return acceptClientReport.issueId;
  };
  const stream = (sub: string, lifetime = 3600, key = kit.key.publicKey) =>
    openStream(kit, token(sub, lifetime), key);
  return { kit, token, mongo, file, as, data, accept, stream, clearIp };
}

// The stream as a browser's `fetch` reads it: events by name, in order.
export async function openStream(
  kit: IntakeKit,
  identity: string | null,
  key: string,
) {
  const controller = new AbortController();
  const response = await kit.kit.app.fetch(
    new Request(
      `https://api.pulsarix.test${LIVE_REQUESTS_PATH}?key=${encodeURIComponent(key)}`,
      {
        signal: controller.signal,
        headers: {
          origin: kit.site,
          ...(identity && { [IDENTITY_HEADER]: identity }),
        },
      },
    ),
  );
  const events: { event: string; data: unknown }[] = [];
  let ended = false;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    try {
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = block.match(/^event: (.*)$/m)?.[1];
          const raw = block.match(/^data: (.*)$/m)?.[1];
          if (name && raw) events.push({ event: name, data: JSON.parse(raw) });
        }
      }
    } catch {}
    ended = true;
  })();
  return {
    response,
    events,
    async next(name: string, ms = 2_000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const at = events.findIndex((e) => e.event === name);
        if (at >= 0)
          return events.splice(at, 1)[0]?.data as Record<string, unknown>;
        if (ended) return null;
        await Bun.sleep(10);
      }
      return null;
    },
    get ended() {
      return ended;
    },
    async untilEnd(ms = 4_000) {
      const until = Date.now() + ms;
      while (!ended && Date.now() < until) await Bun.sleep(20);
      return ended;
    },
    async close() {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await pump;
    },
  };
}
