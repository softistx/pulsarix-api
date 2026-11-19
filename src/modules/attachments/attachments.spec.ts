import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { bucketKeys, call, errorOf, pdf, png, startMediaS3 } from "~/media";
import { maxBytes, maxPerOwner } from "./attachments.kinds";
import type { Media } from "./attachments.storage";

// The file routes (CSRF header, janus Bearer token, x-organization-id, the
// permissions, @alxia/media's checks) over a real S3 API
// (@softistx/s3/testing), no mock of the store.
let s3: TestS3;
let media: Media;
let kit: ReturnType<typeof authApp>;
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
  kit = authApp({ media });
}, 300_000);
// Stopping the store can take longer than the 5 s default under load; an
// overrun would otherwise fail the next file's hooks, unnamed.
afterAll(() => s3.stop(), 60_000);

const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id }
}`;
const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id }
}`;
const DeleteIssue = `mutation($id: ID!) { deleteIssue(id: $id) }`;
const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
const DeleteComment = `mutation($id: ID!) { deleteComment(id: $id) }`;
const List = `query($ownerType: AttachmentOwnerType!, $ownerId: ID!) {
  attachments(ownerType: $ownerType, ownerId: $ownerId) {
    id ownerType ownerId issueId fileName mime size url previewUrl uploadedBy
  }
}`;
const Delete = `mutation($id: ID!) { deleteAttachment(id: $id) }`;

interface Attachment {
  id: string;
  ownerType: string;
  ownerId: string;
  issueId: string;
  fileName: string;
  mime: string;
  size: number;
  url: string;
  previewUrl: string | null;
  uploadedBy: string;
}

async function setup() {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const as = (token: string) =>
    kit.client(token, { organisation: organisation.id });
  const asOwner = as(owner.token);
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string };
  }>(CreateProject, { input: { key: "ABC", name: "Alpha" } });
  const { createIssue: issue } = await asOwner.call<{
    createIssue: { id: string };
  }>(CreateIssue, { input: { projectId: project.id, title: "An issue" } });
  const member = await memberWith(kit, organisation.id, owner.token, "member");
  const other = await memberWith(kit, organisation.id, owner.token, "member");
  const admin = await memberWith(kit, organisation.id, owner.token, "admin");
  const viewer = await memberWith(kit, organisation.id, owner.token, "viewer");
  return {
    owner,
    organisation,
    asOwner,
    issue,
    member,
    other,
    admin,
    viewer,
    as,
  };
}
type World = Awaited<ReturnType<typeof setup>>;

const upload = (
  world: World,
  token: string,
  ownerType: string,
  ownerId: string,
  bytes: Uint8Array,
  options: { type?: string; name?: string | null } = {},
) => {
  const query = new URLSearchParams({ ownerType, ownerId });
  const name = "name" in options ? options.name : "file";
  if (name !== null && name !== undefined) query.set("fileName", name);
  return call(kit.app, `/media/attachments?${query}`, {
    method: "PUT",
    token,
    organisation: world.organisation.id,
    headers: {
      "content-type": options.type ?? "application/pdf",
      "content-length": String(bytes.length),
    },
    body: bytes as unknown as BodyInit,
  });
};

const attach = async (
  world: World,
  token: string,
  ownerType: string,
  ownerId: string,
  bytes: Uint8Array,
  options: { type?: string; name?: string } = {},
) => {
  const response = await upload(
    world,
    token,
    ownerType,
    ownerId,
    bytes,
    options,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    id: string;
    key: string;
    size: number;
    previewKey: string | null;
  };
};

// A valid one-page PDF (offsets computed), small enough to draw in a spec.
const onePagePdf = (): Uint8Array => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>",
    "<< /Length 40 >>\nstream\n0.2 0.4 0.8 rg 20 20 160 260 re f\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
};

const read = (world: World, token: string | null, path: string) =>
  call(kit.app, path, { token, organisation: world.organisation.id });

describe("uploading", () => {
  test("a picture is stored with its thumbnail and listed on its issue", async () => {
    const w = await setup();
    const bytes = png(300, 200);
    const stored = await attach(w, w.member.token, "issue", w.issue.id, bytes, {
      type: "image/png",
      name: "shot.png",
    });
    expect(stored.previewKey).toBe("256");

    const { attachments } = await w
      .as(w.viewer.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments).toEqual([
      {
        id: stored.id,
        ownerType: "issue",
        ownerId: w.issue.id,
        issueId: w.issue.id,
        fileName: "shot.png",
        mime: "image/png",
        size: bytes.length,
        url: `/media/attachments/${stored.key}`,
        previewUrl: `/media/attachments/${stored.key}/256`,
        uploadedBy: w.member.id,
      },
    ]);

    const original = await read(w, w.viewer.token, attachments[0]?.url ?? "");
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
    const thumb = await read(
      w,
      w.viewer.token,
      attachments[0]?.previewUrl ?? "",
    );
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    const decoded = await new Bun.Image(await thumb.arrayBuffer()).metadata();
    expect([decoded.width, decoded.height]).toEqual([256, 256]);
  }, 60_000);

  test("a PDF gets a WebP preview of its first page, served to readers only", async () => {
    const w = await setup();
    const stored = await attach(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      onePagePdf(),
      { name: "page.pdf" },
    );
    expect(stored.previewKey).toBe("256");
    const { attachments } = await w
      .as(w.viewer.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments[0]?.previewUrl).toBe(
      `/media/attachments/${stored.key}/256`,
    );
    const preview = await read(
      w,
      w.viewer.token,
      attachments[0]?.previewUrl ?? "",
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/webp");
    const decoded = await new Bun.Image(await preview.arrayBuffer()).metadata();
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.width).toBeLessThanOrEqual(256);
    expect(decoded.height).toBeLessThanOrEqual(256);
    const anonymous = await read(w, null, attachments[0]?.previewUrl ?? "");
    expect(anonymous.status).toBe(401);
  }, 60_000);

  test("a PDF that cannot be drawn is stored as it is, with no preview", async () => {
    const w = await setup();
    const stored = await attach(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      pdf(100),
      {
        name: "spec.pdf",
      },
    );
    expect(stored.previewKey).toBeNull();
    const { attachments } = await w
      .as(w.member.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments[0]).toMatchObject({
      mime: "application/pdf",
      previewUrl: null,
    });
    const file = await read(w, w.member.token, attachments[0]?.url ?? "");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    const preview = await read(w, w.member.token, `${attachments[0]?.url}/256`);
    expect(preview.status).toBe(404);
  }, 60_000);

  test("a file name is kept as its last path segment", async () => {
    const w = await setup();
    await attach(w, w.member.token, "issue", w.issue.id, pdf(), {
      name: "..\\..//etc/notes.pdf",
    });
    const { attachments } = await w
      .as(w.member.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments[0]?.fileName).toBe("notes.pdf");
  }, 60_000);

  test("a type outside the list, or bytes that are not the declared type, are refused 415", async () => {
    const w = await setup();
    const text = new TextEncoder().encode("hello");
    const plain = await upload(w, w.member.token, "issue", w.issue.id, text, {
      type: "text/plain",
    });
    expect(plain.status).toBe(415);
    expect((await errorOf(plain)).extensions["code"]).toBe(
      "attachments.errors.unsupported-type",
    );
    const html = new TextEncoder().encode("<html><script>alert(1)</script>");
    const disguised = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      html,
      {
        type: "application/pdf",
      },
    );
    expect(disguised.status).toBe(415);
    const { attachments } = await w
      .as(w.member.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments).toEqual([]);
  }, 60_000);

  test("a file over the size limit is refused 413 and nothing is stored", async () => {
    const w = await setup();
    const before = await bucketKeys(s3, `organisations/${w.organisation.id}/`);
    const response = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      pdf(maxBytes),
    );
    expect(response.status).toBe(413);
    const error = await errorOf(response);
    expect(error.extensions["code"]).toBe("attachments.errors.too-large");
    expect(error.extensions["params"]).toEqual({ reason: "bytes", max: 10 });
    expect(await bucketKeys(s3, `organisations/${w.organisation.id}/`)).toEqual(
      before,
    );
  }, 60_000);

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
