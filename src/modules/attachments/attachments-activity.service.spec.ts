import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AddComment,
  attach,
  Delete,
  kit,
  setup,
  startStore,
  stopStore,
  upload,
} from "~/attachments";
import { ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { pdf } from "~/media";

beforeAll(startStore, 300_000);
afterAll(stopStore, 60_000);

const IssueFiles = `query($issueId: ID!) {
  issueAttachments(issueId: $issueId) { id ownerType ownerId issueId fileName }
}`;
const Activity = `query($issueId: ID) {
  activity(issueId: $issueId) {
    nodes { verb actorId changes { field from to } }
  }
}`;
const Watch = `mutation($id: ID!) { watchIssue(id: $id) { id } }`;
const Inbox = `query { notifications { nodes { kind } } }`;

interface Row {
  verb: string;
  actorId: string;
  changes: { field: string; from: string | null; to: string | null }[];
}

describe("activity and issueAttachments", () => {
  test("an upload and a delete are journalled as an `attachment` change and tell the watchers", async () => {
    const w = await setup();
    const watcher = w.as(w.admin.token);
    await watcher.call(Watch, { id: w.issue.id });
    const stored = await attach(w, w.member.token, "issue", w.issue.id, pdf(), {
      name: "spec.pdf",
    });
    await w.as(w.member.token).call(Delete, { id: stored.id });

    const { activity } = await w
      .as(w.viewer.token)
      .call<{ activity: { nodes: Row[] } }>(Activity, { issueId: w.issue.id });
    const rows = activity.nodes.filter((row) => row.verb === "updated");
    // Newest first.
    expect(rows.map((row) => row.changes)).toEqual([
      [{ field: "attachment", from: "spec.pdf", to: null }],
      [{ field: "attachment", from: null, to: "spec.pdf" }],
    ]);
    expect(rows[0]?.actorId).toBe(w.member.id);

    const { notifications } = await watcher.call<{
      notifications: { nodes: { kind: string }[] };
    }>(Inbox);
    expect(notifications.nodes.map((n) => n.kind)).toEqual([
      "watchedChange",
      "watchedChange",
    ]);
  }, 60_000);

  test("issueAttachments lists the files of the issue and of its comments in one query", async () => {
    const w = await setup();
    const { addComment: comment } = await w
      .as(w.member.token)
      .call<{ addComment: { id: string } }>(AddComment, {
        issueId: w.issue.id,
        input: { body: "files" },
      });
    const a = await attach(w, w.member.token, "issue", w.issue.id, pdf(1));
    const b = await attach(w, w.member.token, "comment", comment.id, pdf(2));

    const { issueAttachments } = await w.as(w.viewer.token).call<{
      issueAttachments: {
        id: string;
        ownerType: string;
        ownerId: string;
        issueId: string;
      }[];
    }>(IssueFiles, { issueId: w.issue.id });
    expect(issueAttachments.map((f) => [f.id, f.ownerType, f.ownerId])).toEqual(
      [
        [a.id, "issue", w.issue.id],
        [b.id, "comment", comment.id],
      ],
    );
    expect(issueAttachments.every((f) => f.issueId === w.issue.id)).toBe(true);

    const missing = await w
      .as(w.viewer.token)
      .attempt(IssueFiles, { issueId: "0".repeat(24) });
    expect(codeOf(missing)).toBe("issues.errors.not-found");
  }, 60_000);

  test("a comment's file is journalled on the comment's issue", async () => {
    const w = await setup();
    const { addComment: comment } = await w
      .as(w.member.token)
      .call<{ addComment: { id: string } }>(AddComment, {
        issueId: w.issue.id,
        input: { body: "files" },
      });
    await attach(w, w.member.token, "comment", comment.id, pdf(), {
      name: "c.pdf",
    });
    const { activity } = await w
      .as(w.viewer.token)
      .call<{ activity: { nodes: Row[] } }>(Activity, { issueId: w.issue.id });
    expect(
      activity.nodes.filter((r) => r.verb === "updated").map((r) => r.changes),
    ).toEqual([[{ field: "attachment", from: null, to: "c.pdf" }]]);
  }, 60_000);

  test("a refused upload leaves no activity row", async () => {
    const w = await setup();
    const refused = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      pdf(),
      {
        name: null,
      },
    );
    expect(refused.status).toBe(400);
    const { activity } = await w
      .as(w.viewer.token)
      .call<{ activity: { nodes: Row[] } }>(Activity, { issueId: w.issue.id });
    expect(activity.nodes.filter((r) => r.verb === "updated")).toEqual([]);
  }, 60_000);

  test("issueAttachments is refused to a stranger of the organisation", async () => {
    const w = await setup();
    const foreign = await ownerWithOrganisation(kit, "Elsewhere");
    const answer = await kit
      .client(foreign.owner.token, { organisation: w.organisation.id })
      .attempt(IssueFiles, { issueId: w.issue.id });
    expect(codeOf(answer)).toBe("tenancy.errors.unknown-organization");
  });
});
