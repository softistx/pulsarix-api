import { goodReport, type IntakeKit } from "~/intake";

// A15: public states, links, impact and type (plan §19).
export const Statuses = `query($key: String!) {
  project(key: $key) { statuses { id name category publicState } labels { id name } }
}`;
export const CreateStatus = `mutation($input: CreateStatusInput!) {
  createStatus(input: $input) { id name category publicState }
}`;
export const UpdateStatus = `mutation($id: ID!, $input: UpdateStatusInput!) {
  updateStatus(id: $id, input: $input) { id category publicState }
}`;
export const CreateLabel = `mutation($input: CreateLabelInput!) {
  createLabel(input: $input) { id name }
}`;
export const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id state issueId publicState } }`;
export const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id state declineReasonPublic publicState }
}`;
export const Link = `mutation($id: ID!, $issueId: ID!) {
  linkClientReport(id: $id, issueId: $issueId) { id state issueId linkedAt publicState }
}`;
export const Report = `query($projectId: ID!) {
  clientReports(projectId: $projectId) {
    nodes { id state impact type publicState declineReasonPublic declineReason issueId }
  }
}`;
export const IssueOf = `query($id: ID!) {
  issues(projectId: $id) { nodes { id key type statusId priority priorityOrigin labelIds } }
}`;
export const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
export const Move = `mutation($id: ID!, $statusId: ID!) { moveIssue(id: $id, statusId: $statusId) { id } }`;
export const Update = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { id priority priorityOrigin }
}`;

export interface StatusOut {
  id: string;
  name: string;
  category: string;
  publicState: string;
}
export interface ReportOut {
  id: string;
  state: string;
  issueId: string | null;
  impact: string | null;
  type: string | null;
  publicState: string;
  declineReasonPublic: boolean;
  declineReason: string | null;
}
export interface IssueOut {
  id: string;
  key: string;
  type: string;
  statusId: string;
  priority: string;
  priorityOrigin: string;
  labelIds: string[];
}

export const statusesOf = async (kit: IntakeKit) =>
  (
    await kit.asOwner.call<{
      project: {
        statuses: StatusOut[];
        labels: { id: string; name: string }[];
      };
    }>(Statuses, { key: "ABC" })
  ).project;
export const named = (statuses: StatusOut[], name: string) =>
  statuses.find((status) => status.name === name) as StatusOut;

export async function send(
  kit: IntakeKit,
  extra: Record<string, unknown> = {},
) {
  (
    kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
  ).intakeIpKey.counts.clear();
  const { body } = await kit.submit(goodReport(extra));
  const data = body?.data as unknown as {
    submitClientReport: { reportId: string };
  };
  return data.submitClientReport.reportId;
}
export const reports = async (kit: IntakeKit) =>
  (
    await kit.asOwner.call<{ clientReports: { nodes: ReportOut[] } }>(Report, {
      projectId: kit.project.id,
    })
  ).clientReports.nodes;
export const reportOf = async (kit: IntakeKit, id: string) =>
  (await reports(kit)).find((report) => report.id === id) as ReportOut;
export const accept = (kit: IntakeKit, id: string) =>
  kit.asOwner.call<{ acceptClientReport: ReportOut }>(Accept, { id });
export const issueOf = async (kit: IntakeKit, id: string) =>
  (
    await kit.asOwner.call<{ issues: { nodes: IssueOut[] } }>(IssueOf, {
      id: kit.project.id,
    })
  ).issues.nodes.find((issue) => issue.id === id) as IssueOut;
export const move = (kit: IntakeKit, id: string, statusId: string) =>
  kit.asOwner.call(Move, { id, statusId });
export const tracked = async (kit: IntakeKit, token: string) =>
  (await kit.track(token)).body?.data?.["clientReportStatus"] as Record<
    string,
    unknown
  >;
// A report with an e-mail, so its tracking page can be read.
export async function withTracking(kit: IntakeKit, extra = {}) {
  const id = await send(kit, { email: "r@client.test", ...extra });
  await kit.intake.settled();
  const token = kit.mailer.sent.at(-1)?.text.match(/\/track\/(\S+)/)?.[1];
  return { id, token: token as string };
}
