import { expect } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { call, startMediaS3 } from "~/media";
import type { Media } from "../src/modules/attachments/attachments.store";

// The file routes (CSRF header, janus Bearer token, x-organization-id, the
// permissions, @softistx/alxia-media's checks) over a real S3 API
// (@softistx/s3/testing), no mock of the store.
export let s3: TestS3;
export let media: Media;
export let kit: ReturnType<typeof authApp>;
export const startStore = async () => {
  ({ s3, media } = await startMediaS3());
  kit = authApp({ media });
};
// Stopping the store can take longer than the 5 s default under load; each
// part gives its afterAll 60 s, so an overrun cannot fail the next file's
// hooks, unnamed.
export const stopStore = () => s3.stop();

export const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id }
}`;
export const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id }
}`;
export const DeleteIssue = `mutation($id: ID!) { deleteIssue(id: $id) }`;
export const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
export const DeleteComment = `mutation($id: ID!) { deleteComment(id: $id) }`;
export const List = `query($ownerType: AttachmentOwnerType!, $ownerId: ID!) {
  attachments(ownerType: $ownerType, ownerId: $ownerId) {
    id ownerType ownerId issueId fileName mime size url previewUrl uploadedBy
  }
}`;
export const Delete = `mutation($id: ID!) { deleteAttachment(id: $id) }`;

export interface Attachment {
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

export async function setup() {
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
export type World = Awaited<ReturnType<typeof setup>>;

export const upload = (
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

export const attach = async (
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
export const onePagePdf = (): Uint8Array => {
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

export const read = (world: World, token: string | null, path: string) =>
  call(kit.app, path, { token, organisation: world.organisation.id });
