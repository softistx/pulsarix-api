import { goodReport, type IntakeKit } from "./intake";

export const Keys = `query($projectId: ID!) {
  widgetKeys(projectId: $projectId) {
    id projectId publicKey label allowedOrigins active lastUsedAt
  }
}`;
export const Create = `mutation($input: CreateWidgetKeyInput!) {
  createWidgetKey(input: $input) { id publicKey label allowedOrigins active }
}`;
export const Update = `mutation($id: ID!, $input: UpdateWidgetKeyInput!) {
  updateWidgetKey(id: $id, input: $input) { id label active allowedOrigins }
}`;
export const Rotate = `mutation($id: ID!) { rotateWidgetKey(id: $id) { id publicKey } }`;
export const Revoke = `mutation($id: ID!) { revokeWidgetKey(id: $id) }`;
export const Reports = `query($projectId: ID!, $state: ClientReportState, $first: Int, $after: String) {
  clientReports(projectId: $projectId, state: $state, first: $first, after: $after) {
    nodes { id projectId title description email state issueId declineReason pageUrl userAgent locale metadata { key value } decidedBy decidedAt closedAt erasedAt }
    endCursor hasNextPage
  }
}`;
export const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id state issueId decidedBy } }`;
export const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id state declineReason }
}`;
export const IssueByKey = `query($key: String!) {
  issue(key: $key) { id key title description statusId reporterId clientReportId }
}`;
export const Move = `mutation($id: ID!, $statusId: ID!) { moveIssue(id: $id, statusId: $statusId) { id } }`;
export const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;

export interface Report {
  id: string;
  state: string;
  issueId: string | null;
  title: string;
}

export async function send(
  kit: IntakeKit,
  extra: Record<string, unknown> = {},
) {
  kit.limits &&
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
  const { body } = await kit.submit(goodReport(extra));
  const data = body?.data as unknown as {
    submitClientReport: { reportId: string };
  };
  return data.submitClientReport.reportId;
}

export async function inbox(
  kit: IntakeKit,
  vars: Record<string, unknown> = {},
) {
  return (
    await kit.asOwner.call<{
      clientReports: {
        nodes: Report[];
        endCursor: string | null;
        hasNextPage: boolean;
      };
    }>(Reports, { projectId: kit.project.id, ...vars })
  ).clientReports;
}
