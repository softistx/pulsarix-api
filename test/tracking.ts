import { expect } from "bun:test";
import type { ObjectId } from "mongodb";
import { goodReport, intakeKit } from "~/intake";
import { png, type startMediaS3 } from "~/media";
import { clientHeader } from "../src/http/csrf";
import { TRACKING_HEADER } from "../src/modules/intake/intake.http";

export const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id issueId } }`;
export const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id }
}`;
export const shot = png(64, 48);
export const DAY = 86_400_000;

export type Body = {
  data?: Record<string, unknown> | null;
  errors?: { extensions?: Record<string, unknown> }[];
} | null;

export async function worldWith(
  media: Awaited<ReturnType<typeof startMediaS3>>["media"],
) {
  const kit = await intakeKit({ media });
  let n = 0;
  const clearIp = () =>
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
  // A report with an e-mail: its tracking token and its id.
  const report = async (extra: Record<string, unknown> = {}) => {
    clearIp();
    n += 1;
    const email = `reporter${n}@example.com`;
    const { body } = await kit.submit(goodReport({ email, ...extra }));
    const sent = (body as Body)?.data?.["submitClientReport"] as {
      reportId: string;
      files: { slot: string; ticket: string }[];
    };
    await kit.intake.settled();
    const mail = kit.mailer.sent.at(-1);
    const token = mail?.text.match(/\/track\/(\S+)/)?.[1] ?? "";
    return { id: sent.reportId, token, files: sent.files };
  };
  // An operation as the UI server makes it: no Origin, the client header, the
  // tracking token in its header.
  const ui = async (
    id: string,
    token: string | null,
    variables: Record<string, unknown> = {},
    headers: Record<string, string | null> = {},
  ) => {
    const { response, body } = await kit.op(id, variables, {
      origin: null,
      [clientHeader]: "pulsarix-ui",
      ...(token !== null && { [TRACKING_HEADER]: token }),
      ...headers,
    });
    return { status: response.status, body: body as Body };
  };
  const status = async (token: string) => {
    const { status: code, body } = await ui("clientReportStatus", token);
    expect(code).toBe(200);
    return body?.data?.["clientReportStatus"] as Record<string, unknown>;
  };
  const accept = async (reportId: string) => {
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: reportId });
    return acceptClientReport.issueId;
  };
  const mongo = await import("../src/config/db").then(
    async (m) =>
      (await m.tenancy.databaseOf(kit.organisation.id)) as never as {
        db: {
          clientReports: {
            findById: (id: ObjectId) => Promise<Record<string, unknown> | null>;
            update: (id: ObjectId, patch: object) => Promise<unknown>;
          };
        };
      },
  );
  return { kit, report, ui, status, accept, mongo };
}

export const OPS: [string, Record<string, unknown>][] = [
  ["clientReportStatus", {}],
  ["trackingReply", { input: { body: "hello" } }],
  ["trackingResolve", {}],
  ["trackingReopen", {}],
  ["trackingErase", {}],
  ["trackingEmails", { on: false }],
];
