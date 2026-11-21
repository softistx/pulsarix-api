import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AddComment,
  type Attachment,
  attach,
  CreateIssue,
  CreateProject,
  Delete,
  List,
  s3,
  setup,
  startStore,
  stopStore,
  upload,
} from "~/attachments";
import { codeOf } from "~/http";
import { bucketKeys, errorOf, pdf } from "~/media";

beforeAll(startStore, 300_000);
afterAll(stopStore, 60_000);

const ArchiveProject = `mutation($id: ID!) { archiveProject(id: $id) { id } }`;
const UnarchiveProject = `mutation($id: ID!) { unarchiveProject(id: $id) { id } }`;

describe("an archived project", () => {
  test("refuses an upload to an issue or a comment, and a delete, but still lists the files", async () => {
    const w = await setup();
    const { createProject: project } = await w.asOwner.call<{
      createProject: { id: string };
    }>(CreateProject, { input: { key: "ZZZ", name: "Zeta" } });
    const { createIssue: issue } = await w.asOwner.call<{
      createIssue: { id: string };
    }>(CreateIssue, { input: { projectId: project.id, title: "Archived" } });
    const { addComment: comment } = await w.asOwner.call<{
      addComment: { id: string };
    }>(AddComment, { issueId: issue.id, input: { body: "with a file" } });
    const file = await attach(w, w.owner.token, "issue", issue.id, pdf());
    const prefix = `organisations/${w.organisation.id}/`;
    const stored = await bucketKeys(s3, prefix);

    await w.asOwner.call(ArchiveProject, { id: project.id });

    for (const [ownerType, ownerId] of [
      ["issue", issue.id],
      ["comment", comment.id],
    ] as const) {
      const response = await upload(
        w,
        w.owner.token,
        ownerType,
        ownerId,
        pdf(),
      );
      expect(response.status).toBe(409);
      expect((await errorOf(response)).extensions["code"]).toBe(
        "issues.errors.project-archived",
      );
    }
    // Refused before the file is stored: the bucket did not grow.
    expect(await bucketKeys(s3, prefix)).toEqual(stored);

    const refused = await w.asOwner.attempt(Delete, { id: file.id });
    expect(codeOf(refused)).toBe("issues.errors.project-archived");

    // Reading stays allowed.
    const listed = await w.asOwner.call<{ attachments: Attachment[] }>(List, {
      ownerType: "issue",
      ownerId: issue.id,
    });
    expect(listed.attachments).toHaveLength(1);

    // Unarchiving restores the writes.
    await w.asOwner.call(UnarchiveProject, { id: project.id });
    await attach(w, w.owner.token, "issue", issue.id, pdf());
    const deleted = await w.asOwner.call<{ deleteAttachment: string }>(Delete, {
      id: file.id,
    });
    expect(deleted.deleteAttachment).toBe(file.id);
  });
});
