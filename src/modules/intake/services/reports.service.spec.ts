import { describe, expect, test } from "bun:test";
import { memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { asPreV2Key, codeOfBody, intakeKit } from "~/intake";
import { Create, Keys, Revoke, Rotate, Update } from "~/reports";
import { coreMongo } from "../../../config/db";

describe("widget keys", () => {
  test("an admin makes, lists, edits, rotates and revokes a key", async () => {
    const kit = await intakeKit();
    const admin = await memberWith(
      kit.kit,
      kit.organisation.id,
      kit.owner.token,
      "admin",
    );
    const asAdmin = kit.kit.client(admin.token, {
      organisation: kit.organisation.id,
    });
    const made = await asAdmin.call<{
      createWidgetKey: { id: string; publicKey: string; active: boolean };
    }>(Create, {
      input: {
        projectId: kit.project.id,
        label: " Docs ",
        allowedOrigins: ["https://docs.client.test"],
      },
    });
    expect(made.createWidgetKey.publicKey).toMatch(
      /^pk_live_[A-Za-z0-9_-]{32}$/,
    );
    expect(made.createWidgetKey.active).toBe(true);
    const listed = await asAdmin.call<{ widgetKeys: { label: string }[] }>(
      Keys,
      { projectId: kit.project.id },
    );
    expect(listed.widgetKeys.map((k) => k.label)).toEqual(["Site", "Docs"]);

    const updated = await asAdmin.call<{
      updateWidgetKey: { label: string; active: boolean };
    }>(Update, {
      id: made.createWidgetKey.id,
      input: { label: "Documentation", active: false },
    });
    expect(updated.updateWidgetKey).toMatchObject({
      label: "Documentation",
      active: false,
    });
    expect(
      codeOf(
        await asAdmin.attempt(Update, {
          id: made.createWidgetKey.id,
          input: { label: null },
        }),
      ),
    ).toBe("validation.errors.invalid-input");

    const rotated = await asAdmin.call<{
      rotateWidgetKey: { publicKey: string };
    }>(Rotate, {
      id: made.createWidgetKey.id,
    });
    expect(rotated.rotateWidgetKey.publicKey).not.toBe(
      made.createWidgetKey.publicKey,
    );
    // The old value is unknown from then on, the new one is the key.
    const old = await kit.config({}, made.createWidgetKey.publicKey);
    expect(codeOfBody(old.body)).toBe("intake.errors.unknown-key");

    await asAdmin.call(Revoke, { id: made.createWidgetKey.id });
    const after = await asAdmin.call<{ widgetKeys: { label: string }[] }>(
      Keys,
      { projectId: kit.project.id },
    );
    expect(after.widgetKeys.map((k) => k.label)).toEqual(["Site"]);
    expect(
      codeOf(await asAdmin.attempt(Revoke, { id: made.createWidgetKey.id })),
    ).toBe("intake.errors.key-not-found");
  });

  test("a key stored before v2 lists with no uploads and no refusals", async () => {
    const kit = await intakeKit();
    await asPreV2Key(kit);
    const listed = await kit.asOwner.call<{
      widgetKeys: {
        attachmentsEnabled: boolean;
        uploads: number;
        refusals: unknown[];
      }[];
    }>(
      `query($projectId: ID!) { widgetKeys(projectId: $projectId) { attachmentsEnabled uploads refusals { reason count } } }`,
      { projectId: kit.project.id },
    );
    expect(listed.widgetKeys).toEqual([
      { attachmentsEnabled: true, uploads: 0, refusals: [] },
    ]);
  });

  test("a member, a viewer and an anonymous caller manage no key", async () => {
    const kit = await intakeKit();
    for (const role of ["member", "viewer"] as const) {
      const who = await memberWith(
        kit.kit,
        kit.organisation.id,
        kit.owner.token,
        role,
      );
      const as = kit.kit.client(who.token, {
        organisation: kit.organisation.id,
      });
      expect(
        codeOf(await as.attempt(Keys, { projectId: kit.project.id })),
      ).toBe("auth.errors.forbidden");
      expect(
        codeOf(
          await as.attempt(Create, {
            input: {
              projectId: kit.project.id,
              label: "x",
              allowedOrigins: ["https://x.test"],
            },
          }),
        ),
      ).toBe("auth.errors.forbidden");
      expect(codeOf(await as.attempt(Revoke, { id: kit.key.id }))).toBe(
        "auth.errors.forbidden",
      );
    }
    expect(
      codeOf(
        await kit.kit.client().attempt(Keys, { projectId: kit.project.id }),
      ),
    ).toBe("auth.errors.unauthenticated");
  });

  test("creating or rotating a key asks for a recent proof of identity", async () => {
    const kit = await intakeKit();
    kit.kit.clock.advance(11 * 60_000);
    const as = kit.asOwner;
    expect(
      codeOf(
        await as.attempt(Create, {
          input: {
            projectId: kit.project.id,
            label: "x",
            allowedOrigins: ["https://x.test"],
          },
        }),
      ),
    ).toBe("auth.errors.step-up-required");
    expect(codeOf(await as.attempt(Rotate, { id: kit.key.id }))).toBe(
      "auth.errors.step-up-required",
    );
  });

  test("a key needs at least one origin, and a known project", async () => {
    const kit = await intakeKit();
    expect(
      codeOf(
        await kit.asOwner.attempt(Create, {
          input: { projectId: kit.project.id, label: "x", allowedOrigins: [] },
        }),
      ),
    ).toBe("validation.errors.invalid-input");
    expect(
      codeOf(
        await kit.asOwner.attempt(Create, {
          input: {
            projectId: "019a0000000070008000000a",
            label: "x",
            allowedOrigins: ["https://x.test"],
          },
        }),
      ),
    ).toBe("projects.errors.not-found");
  });

  test("another organisation's admin reads and touches none of these keys", async () => {
    const kit = await intakeKit();
    const stranger = await ownerWithOrganisation(kit.kit, "Elsewhere");
    const as = kit.kit.client(stranger.owner.token, {
      organisation: stranger.organisation.id,
    });
    expect(codeOf(await as.attempt(Keys, { projectId: kit.project.id }))).toBe(
      "projects.errors.not-found",
    );
    for (const attempt of [
      as.attempt(Update, { id: kit.key.id, input: { active: false } }),
      as.attempt(Rotate, { id: kit.key.id }),
      as.attempt(Revoke, { id: kit.key.id }),
    ]) {
      expect(codeOf(await attempt)).toBe("intake.errors.key-not-found");
    }
    const stored = await coreMongo.db.widgetKeys.findFirst({
      publicKey: kit.key.publicKey,
    });
    expect(stored?.active).toBe(true);
    expect(stored?.revokedAt).toBeNull();
  });
});
