import { afterAll, beforeAll, expect } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { clientHeader } from "../src/http/csrf";
import { TRACKING_HEADER } from "../src/modules/intake/intake.http";
import { TICKET_HEADER } from "../src/modules/intake/utils/tickets.utils";
import { memberWith } from "./auth";
import { goodReport, type IntakeKit, intakeKit } from "./intake";
import { call, onePagePdf, png, startMediaS3 } from "./media";

export let s3: TestS3;
export let media: Awaited<ReturnType<typeof startMediaS3>>["media"];
export function useMediaS3() {
  beforeAll(async () => {
    ({ s3, media } = await startMediaS3());
  }, 300_000);
  afterAll(() => s3.stop(), 60_000);
}

export const shot = png(64, 48);
export const pdf = onePagePdf();

export const Reports = `query($projectId: ID!) {
  clientReports(projectId: $projectId) {
    nodes { id state files { id reportId role fileName mime size state width height url previewUrl } }
  }
}`;
export const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id state issueId files { id state } } }`;
export const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id state files { id state } }
}`;
export const IssueFiles = `query($issueId: ID!) {
  issueClientReportFiles(issueId: $issueId) { id state fileName url previewUrl }
}`;
export const IssueAttachments = `query($issueId: ID!) { issueAttachments(issueId: $issueId) { id } }`;
export const Keys = `query($projectId: ID!) {
  widgetKeys(projectId: $projectId) { id uploads refusals { reason count } }
}`;

export interface FileOut {
  id: string;
  state: string;
  fileName: string;
  mime: string;
  url: string;
  previewUrl: string | null;
}
export interface ReportOut {
  id: string;
  state: string;
  files: FileOut[];
}

// A report with a screenshot and a PDF, both stored; the reporter gave an
// e-mail, so a tracking token was mailed.
export async function reportWithFiles(kit: IntakeKit) {
  const sent = await kit.submit(
    goodReport({
      email: "reporter@client.test",
      files: [
        {
          role: "screenshot",
          name: "screen.png",
          type: "image/png",
          size: shot.length,
        },
        {
          role: "file",
          name: "notes.pdf",
          type: "application/pdf",
          size: pdf.length,
        },
      ],
    }),
  );
  const data = sent.body?.data as unknown as {
    submitClientReport: {
      reportId: string;
      files: { slot: string; ticket: string }[];
    };
  };
  const { reportId, files } = data.submitClientReport;
  const bytes = [shot, pdf];
  const types = ["image/png", "application/pdf"];
  for (const [index, file] of files.entries()) {
    const answer = await kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test/public/media/report-files/${file.slot}`,
        {
          method: "PUT",
          headers: {
            "content-type": types[index] as string,
            "content-length": String(bytes[index]?.length),
            [TICKET_HEADER]: file.ticket,
            origin: kit.site,
          },
          body: bytes[index] as unknown as BodyInit,
          duplex: "half",
        } as RequestInit,
      ),
    );
    expect(answer.status).toBe(200);
  }
  await kit.intake.settled();
  const mail = kit.mailer.sent.at(-1);
  const token = mail?.text.match(/\/track\/(\S+)/)?.[1] as string;
  return { reportId, token };
}

export const setup = async () => {
  const kit = await intakeKit({ media });
  const viewer = await memberWith(
    kit.kit,
    kit.organisation.id,
    kit.owner.token,
    "viewer",
  );
  const member = await memberWith(
    kit.kit,
    kit.organisation.id,
    kit.owner.token,
    "member",
  );
  const as = (token: string) =>
    kit.kit.client(token, { organisation: kit.organisation.id });
  const read = (token: string | null, path: string) =>
    call(kit.kit.app, path, {
      token,
      organisation: kit.organisation.id,
    });
  return { kit, viewer, member, as, read };
};

export const inbox = async (w: Awaited<ReturnType<typeof setup>>) => {
  const read = await w.kit.asOwner.call<{
    clientReports: { nodes: ReportOut[] };
  }>(Reports, { projectId: w.kit.project.id });
  return read.clientReports.nodes;
};

export const trackedRead = (
  kit: IntakeKit,
  path: string,
  token: string,
  headers: Record<string, string> = {},
) =>
  kit.kit.app.fetch(
    new Request(`https://api.pulsarix.test${path}`, {
      headers: {
        [clientHeader]: "pulsarix-ui",
        [TRACKING_HEADER]: token,
        ...headers,
      },
    }),
  );
