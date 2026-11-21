import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AddComment,
  attach,
  Delete,
  DeleteComment,
  DeleteIssue,
  kit,
  List,
  read,
  s3,
  setup,
  startStore,
  stopStore,
  upload,
} from "~/attachments";
import { authApp, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { bucketKeys, call, errorOf, pdf, png } from "~/media";

beforeAll(startStore, 300_000);
afterAll(stopStore, 60_000);

describe("who may upload and read", () => {
  test("only readers of the issue are served its files", async () => {
    const w = await setup();
    const stored = await attach(w, w.member.token, "issue", w.issue.id, pdf());
    const path = `/media/attachments/${stored.key}`;

    // A viewer reads but does not upload.
    expect((await read(w, w.viewer.token, path)).status).toBe(200);
    const viewerUpload = await upload(
      w,
      w.viewer.token,
      "issue",
      w.issue.id,
      pdf(),
    );
    expect(viewerUpload.status).toBe(403);

    // No session, no client header, no organisation.
    const anonymous = await read(w, null, path);
    expect(anonymous.status).toBe(401);
    const noClient = await call(kit.app, path, {
      token: w.member.token,
      organisation: w.organisation.id,
      client: false,
    });
    expect(noClient.status).toBe(403);
    const noOrganisation = await call(kit.app, path, { token: w.member.token });
    expect(noOrganisation.status).toBe(400);

    // Another organisation's member, in their own organisation, finds nothing
    // under this key; in this organisation they are no member.
    const foreign = await ownerWithOrganisation(kit, "Elsewhere");
    const inTheirs = await call(kit.app, path, {
      token: foreign.owner.token,
      organisation: foreign.organisation.id,
    });
    expect(inTheirs.status).toBe(404);
    const inOurs = await call(kit.app, path, {
      token: foreign.owner.token,
      organisation: w.organisation.id,
    });
    expect(inOurs.status).toBe(404);
    expect((await errorOf(inOurs)).extensions["code"]).toBe(
      "tenancy.errors.unknown-organization",
    );

    // A key nobody attached is a 404 as well.
    const unknownKey = await read(
      w,
      w.member.token,
      `/media/attachments/${crypto.randomUUID()}`,
    );
    expect(unknownKey.status).toBe(404);
  }, 60_000);

  test("the files of an issue are not listed to a stranger", async () => {
    const w = await setup();
    const foreign = await ownerWithOrganisation(kit, "Elsewhere");
    const answer = await kit
      .client(foreign.owner.token, { organisation: w.organisation.id })
      .attempt(List, { ownerType: "issue", ownerId: w.issue.id });
    expect(codeOf(answer)).toBe("tenancy.errors.unknown-organization");
  });

  test("without a file store the routes answer 503", async () => {
    const bare = authApp({ media: undefined });
    const { owner, organisation } = await ownerWithOrganisation(bare);
    const response = await call(bare.app, "/media/attachments", {
      method: "PUT",
      token: owner.token,
      organisation: organisation.id,
      headers: { "content-type": "application/pdf" },
      body: pdf() as unknown as BodyInit,
    });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "attachments.errors.unavailable",
    );
  });
});

describe("deleting", () => {
  test("the uploader or an admin deletes a file and its objects leave the bucket", async () => {
    const w = await setup();
    const prefix = `organisations/${w.organisation.id}/`;
    const mine = await attach(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      png(64, 64),
      {
        type: "image/png",
      },
    );
    const theirs = await attach(w, w.other.token, "issue", w.issue.id, pdf());
    expect(await bucketKeys(s3, prefix)).toHaveLength(3);

    // Not the uploader: the file does not exist for them.
    const refused = await w.as(w.other.token).attempt(Delete, { id: mine.id });
    expect(codeOf(refused)).toBe("attachments.errors.not-found");
    expect(await bucketKeys(s3, prefix)).toHaveLength(3);

    const deleted = await w
      .as(w.member.token)
      .call<{ deleteAttachment: string }>(Delete, { id: mine.id });
    expect(deleted.deleteAttachment).toBe(mine.id);
    expect(await bucketKeys(s3, prefix)).toHaveLength(1);
    const gone = await read(
      w,
      w.member.token,
      `/media/attachments/${mine.key}`,
    );
    expect(gone.status).toBe(404);

    await w.as(w.admin.token).call(Delete, { id: theirs.id });
    expect(await bucketKeys(s3, prefix)).toEqual([]);
  }, 60_000);

  test("a viewer cannot delete", async () => {
    const w = await setup();
    const stored = await attach(w, w.member.token, "issue", w.issue.id, pdf());
    const answer = await w
      .as(w.viewer.token)
      .attempt(Delete, { id: stored.id });
    expect(codeOf(answer)).toBe("auth.errors.forbidden");
  }, 60_000);

  test("deleting a comment deletes its files, deleting an issue deletes all of its files", async () => {
    const w = await setup();
    const prefix = `organisations/${w.organisation.id}/`;
    const asMember = w.as(w.member.token);
    const { addComment: comment } = await asMember.call<{
      addComment: { id: string };
    }>(AddComment, { issueId: w.issue.id, input: { body: "files" } });
    await attach(w, w.member.token, "comment", comment.id, pdf());
    await attach(w, w.member.token, "issue", w.issue.id, pdf(1));
    expect(await bucketKeys(s3, prefix)).toHaveLength(2);

    await asMember.call(DeleteComment, { id: comment.id });
    expect(await bucketKeys(s3, prefix)).toHaveLength(1);

    const { addComment: second } = await asMember.call<{
      addComment: { id: string };
    }>(AddComment, { issueId: w.issue.id, input: { body: "more" } });
    await attach(w, w.member.token, "comment", second.id, pdf(2));
    expect(await bucketKeys(s3, prefix)).toHaveLength(2);

    await w.asOwner.call(DeleteIssue, { id: w.issue.id });
    expect(await bucketKeys(s3, prefix)).toEqual([]);
  }, 60_000);
});
