import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AddComment,
  type Attachment,
  attach,
  List,
  s3,
  setup,
  startStore,
  stopStore,
  upload,
} from "~/attachments";
import { bucketKeys, errorOf, pdf, png } from "~/media";
import { maxPerOwner } from "./attachments.kinds";

beforeAll(startStore, 300_000);
afterAll(stopStore, 60_000);

describe("uploading", () => {
  test("a damaged picture is refused 422 and removed", async () => {
    const w = await setup();
    const broken = png(64, 64).slice(0, 80);
    const response = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      broken,
      {
        type: "image/png",
      },
    );
    expect(response.status).toBe(422);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "attachments.errors.undecodable",
    );
    expect(await bucketKeys(s3, `organisations/${w.organisation.id}/`)).toEqual(
      [],
    );
  }, 60_000);

  test("a zero-length upload is refused 422 and nothing is stored", async () => {
    const w = await setup();
    const response = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      new Uint8Array(0),
    );
    expect(response.status).toBe(422);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "attachments.errors.undecodable",
    );
    expect(await bucketKeys(s3, `organisations/${w.organisation.id}/`)).toEqual(
      [],
    );
  }, 60_000);

  test("a picture under 16 px is refused 422", async () => {
    const w = await setup();
    const response = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      png(8, 8),
      { type: "image/png" },
    );
    expect(response.status).toBe(422);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "attachments.errors.too-small",
    );
  }, 60_000);

  test("an owner carries at most maxPerOwner files", async () => {
    const w = await setup();
    for (let i = 0; i < maxPerOwner; i += 1) {
      await attach(w, w.member.token, "issue", w.issue.id, pdf(i), {
        name: `f${i}.pdf`,
      });
    }
    const response = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      pdf(),
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "attachments.errors.too-many",
    );
  }, 120_000);

  test("the owner and the file name must be valid", async () => {
    const w = await setup();
    const noName = await upload(w, w.member.token, "issue", w.issue.id, pdf(), {
      name: null,
    });
    expect(noName.status).toBe(400);
    const badType = await upload(
      w,
      w.member.token,
      "project",
      w.issue.id,
      pdf(),
    );
    expect(badType.status).toBe(400);
    const badId = await upload(w, w.member.token, "issue", "nope", pdf());
    expect(badId.status).toBe(400);
    const unknown = await upload(
      w,
      w.member.token,
      "issue",
      "5f1d7f3e9b1e8b0012345678",
      pdf(),
    );
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).extensions["code"]).toBe(
      "issues.errors.not-found",
    );
  }, 60_000);

  test("a comment's files are added by its author or an admin", async () => {
    const w = await setup();
    const { addComment: comment } = await w
      .as(w.member.token)
      .call<{ addComment: { id: string } }>(AddComment, {
        issueId: w.issue.id,
        input: { body: "see attached" },
      });
    const stranger = await upload(
      w,
      w.other.token,
      "comment",
      comment.id,
      pdf(),
    );
    expect(stranger.status).toBe(403);
    expect((await errorOf(stranger)).extensions["code"]).toBe(
      "comments.errors.not-yours",
    );
    await attach(w, w.member.token, "comment", comment.id, pdf());
    await attach(w, w.admin.token, "comment", comment.id, pdf(1));
    const { attachments } = await w
      .as(w.viewer.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "comment",
        ownerId: comment.id,
      });
    expect(attachments.map((a) => [a.ownerType, a.issueId])).toEqual([
      ["comment", w.issue.id],
      ["comment", w.issue.id],
    ]);
  }, 60_000);
});
