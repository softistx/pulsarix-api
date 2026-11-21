import { describe, expect, test } from "bun:test";
import {
  Board,
  CreateProject,
  IssueLive,
  Notifications,
  Reports,
  setup,
} from "~/activity";
import { authApp, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();

describe("who may subscribe", () => {
  test("a viewer reads the board; anonymous, a stranger and a wrong organisation are refused", async () => {
    const { project, viewer, live, issue } = await setup(kit);
    const created = await issue();
    const ok = await live(viewer.token)(Board, { projectId: project.id });
    expect(ok.status).toBe(200);
    expect((await ok.next(300))?.errors).toBeUndefined();
    await ok.close();

    const anonymous = await live(null)(Board, { projectId: project.id });
    expect(codeOf((await anonymous.next()) ?? {})).toBe(
      "auth.errors.unauthenticated",
    );
    await anonymous.close();

    // An account of another organisation is no member of this one.
    const other = await ownerWithOrganisation(kit, "Other");
    const stranger = await live(other.owner.token)(IssueLive, {
      issueId: created.id,
    });
    expect(codeOf((await stranger.next()) ?? {})).toBe(
      "tenancy.errors.unknown-organization",
    );
    await stranger.close();

    const noOrg = await live(viewer.token, null)(Board, {
      projectId: project.id,
    });
    expect(codeOf((await noOrg.next()) ?? {})).toBe(
      "tenancy.errors.organization-required",
    );
    await noOrg.close();
  });

  test("a project or issue of another organisation is unknown, not forbidden", async () => {
    const { owner, live } = await setup(kit);
    const other = await ownerWithOrganisation(kit, "Elsewhere");
    const { createProject: otherProject } = await kit
      .client(other.owner.token, { organisation: other.organisation.id })
      .call<{ createProject: { id: string } }>(CreateProject, {
        input: { key: "XYZ", name: "Zed" },
      });
    const foreign = await live(owner.token)(Board, {
      projectId: otherProject.id,
    });
    expect(codeOf((await foreign.next()) ?? {})).toBe(
      "projects.errors.not-found",
    );
    await foreign.close();
    const malformed = await live(owner.token)(IssueLive, { issueId: "nope" });
    expect(codeOf((await malformed.next()) ?? {})).toBe(
      "validation.errors.invalid-input",
    );
    await malformed.close();
  });

  test("intake reports need the right to write issues; notifications are the viewer's own", async () => {
    const { project, viewer, member, live } = await setup(kit);
    const refused = await live(viewer.token)(Reports, {
      projectId: project.id,
    });
    expect(codeOf((await refused.next()) ?? {})).toBe("auth.errors.forbidden");
    await refused.close();

    const allowed = await live(member.token)(Reports, {
      projectId: project.id,
    });
    expect((await allowed.next(300))?.errors).toBeUndefined();
    await allowed.close();

    const own = await live(viewer.token)(Notifications);
    expect((await own.next(300))?.errors).toBeUndefined();
    await own.close();
    const anonymous = await live(null)(Notifications);
    expect(codeOf((await anonymous.next()) ?? {})).toBe(
      "auth.errors.unauthenticated",
    );
    await anonymous.close();
  });
});
