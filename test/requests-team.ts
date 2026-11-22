import { goodReport } from "~/intake";
import { world } from "~/requests";

export const Inbox = `query($projectId: ID, $filter: ClientReportFilter, $first: Int, $after: String) {
  clientReports(projectId: $projectId, filter: $filter, first: $first, after: $after) {
    nodes { id title state clientWaiting }
    endCursor hasNextPage
  }
}`;
export const Counts = `query($projectId: ID) {
  clientReportCounts(projectId: $projectId) { new accepted declined closed clientWaiting total }
}`;
export const One = `query($id: ID!) {
  clientReport(id: $id) {
    id pageUrl impact type clientWaiting
    issues { id }
    thread { id source body authorId issueId }
  }
}`;
export const Reply = `mutation($id: ID!, $input: ReplyToClientReportInput!) {
  replyToClientReport(id: $id, input: $input) { id clientWaiting }
}`;
export const Link = `mutation($id: ID!, $issueId: ID!) { linkClientReport(id: $id, issueId: $issueId) { id } }`;
export const Comment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
export const Live = `subscription { requestsChanged { reportId projectId kind at } }`;

export interface Page {
  clientReports: {
    nodes: { id: string; title: string; state: string }[];
    endCursor: string | null;
    hasNextPage: boolean;
  };
}
export interface Thread {
  clientReport: {
    thread: { source: string; body: string; authorId: string | null }[];
    clientWaiting: boolean;
  } | null;
}

// Three requests over two projects: ada's (waits on the team, accepted
// later), bob's (accepted) and cy's, new, on the other project.
export async function setup() {
  const w = await world();
  const { createProject: other } = await w.kit.asOwner.call<{
    createProject: { id: string };
  }>(
    `mutation($input: CreateProjectInput!) { createProject(input: $input) { id } }`,
    { input: { key: "OTH", name: "Other" } },
  );
  const { createWidgetKey: key } = await w.kit.asOwner.call<{
    createWidgetKey: { publicKey: string };
  }>(
    `mutation($input: CreateWidgetKeyInput!) { createWidgetKey(input: $input) { publicKey } }`,
    {
      input: {
        projectId: other.id,
        label: "Other",
        allowedOrigins: [w.kit.site],
      },
    },
  );
  const ada = await w.file("ada");
  const bob = await w.file("bob");
  await w.accept(bob);
  await w.data("ada", "replyToRequest", { id: ada, input: { body: "Hi" } });
  w.clearIp();
  const { body } = await w.kit.submit(
    goodReport({ title: "By cy" }),
    {},
    key.publicKey,
  );
  const cy = (
    body as unknown as { data: { submitClientReport: { reportId: string } } }
  ).data.submitClientReport.reportId;
  return { w, other, ada, bob, cy };
}
