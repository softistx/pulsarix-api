import { describe, expect, test } from "bun:test";
import { authApp, ownerWithOrganisation, signedUp } from "~/auth";
import { codeOf } from "~/http";
import { coreMongo } from "../../config/db";
import { slugOf } from "./organisations.service";

const kit = authApp();

const Create = `mutation($input: CreateOrganisationInput!) {
  createOrganisation(input: $input) {
    role permissions
    organisation { id name slug timeZone viewerPermissions }
  }
}`;

describe("createOrganisation", () => {
  test("makes the organisation, its database, and its owner", async () => {
    const account = await signedUp(kit);
    const me = kit.client(account.token);
    const created = await me.call<{
      createOrganisation: {
        role: string;
        permissions: string[];
        organisation: {
          id: string;
          name: string;
          slug: string;
          timeZone: string;
          viewerPermissions: string[];
        };
      };
    }>(Create, { input: { name: "Écran Étoilé", timeZone: "Europe/Paris" } });
    const { role, permissions, organisation } = created.createOrganisation;
    expect(role).toBe("owner");
    expect(organisation).toMatchObject({
      name: "Écran Étoilé",
      slug: "ecran-etoile",
      timeZone: "Europe/Paris",
    });
    expect(permissions).toContain("organisation:manage");
    expect(organisation.viewerPermissions).toEqual(permissions);

    // The registry holds it, active, and the switcher lists it with the role.
    const stored = await coreMongo.db.organisations.findById(
      organisation.id as never,
    );
    expect(stored?.status).toBe("active");
    const mine = await me.call<{
      myOrganisations: { role: string; organisation: { id: string } }[];
    }>(`{ myOrganisations { role organisation { id } } }`);
    expect(mine.myOrganisations).toEqual([
      { role: "owner", organisation: { id: organisation.id } },
    ]);

    // It can be named by id or by slug (the header takes either).
    for (const named of [organisation.id, organisation.slug]) {
      const read = await kit
        .client(account.token, { organisation: named })
        .call<{ organisation: { id: string } }>(`{ organisation { id } }`);
      expect(read.organisation.id).toBe(organisation.id);
    }
  });

  test("a slug is taken once, and must be well formed", async () => {
    const first = await ownerWithOrganisation(kit, "Taken Name");
    const other = await signedUp(kit);
    const taken = await kit.client(other.token).attempt(Create, {
      input: { name: "Whatever", slug: first.organisation.slug },
    });
    expect(codeOf(taken)).toBe("tenancy.errors.slug-taken");
    const bad = await kit.client(other.token).attempt(Create, {
      input: { name: "Bad", slug: "Not A Slug", timeZone: "Mars/Base" },
    });
    expect(codeOf(bad)).toBe("validation.errors.invalid-input");
    expect(
      bad.errors?.[0]?.extensions?.fields?.map((f) => f.path).sort(),
    ).toEqual(["slug", "timeZone"]);
  });

  test("needs a signed-in account", async () => {
    expect(
      codeOf(await kit.client().attempt(Create, { input: { name: "Nobody" } })),
    ).toBe("auth.errors.unauthenticated");
  });

  test("slugOf makes an address from any name", () => {
    expect(slugOf("North Star Ltd.")).toBe("north-star-ltd");
    expect(slugOf("  --Équipe  Été-- ")).toBe("equipe-ete");
    expect(slugOf("!!!")).toMatch(/^org-[0-9a-f]{8}$/);
    expect(slugOf("a".repeat(24).replace(/a/g, "f"))).toMatch(/^org-/);
  });
});

describe("one organisation never reads another's", () => {
  test("the header of an organisation the viewer is not in is the same 404 as an unknown one", async () => {
    const a = await ownerWithOrganisation(kit, "Org A");
    const b = await ownerWithOrganisation(kit, "Org B");
    const asA = (organisation: string) =>
      kit.client(a.owner.token, { organisation });
    const own = await asA(a.organisation.id).call<{
      organisation: { id: string };
    }>(`{ organisation { id } }`);
    expect(own.organisation.id).toBe(a.organisation.id);
    for (const query of [
      `{ organisation { id } }`,
      `{ members { id } }`,
      `{ invitations { id } }`,
    ]) {
      const foreign = await asA(b.organisation.id).attempt(query);
      expect(codeOf(foreign)).toBe("tenancy.errors.unknown-organization");
    }
    const unknown = await asA("0".repeat(24)).attempt(
      `{ organisation { id } }`,
    );
    expect(unknown.errors?.[0]?.message).toBe(
      (await asA(b.organisation.id).attempt(`{ organisation { id } }`))
        .errors?.[0]?.message,
    );
    // Nor can A's owner write to B.
    expect(
      codeOf(
        await asA(b.organisation.id).attempt(
          `mutation { updateOrganisation(input: { name: "Hijacked" }) { id } }`,
        ),
      ),
    ).toBe("tenancy.errors.unknown-organization");
  });
});

describe("updateOrganisation", () => {
  test("an owner renames; a member is refused", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit, "Before");
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    const renamed = await asOwner.call<{
      updateOrganisation: { name: string; timeZone: string };
    }>(
      `mutation { updateOrganisation(input: { name: "After", timeZone: "America/Toronto" }) { name timeZone } }`,
    );
    expect(renamed.updateOrganisation).toEqual({
      name: "After",
      timeZone: "America/Toronto",
    });
    expect(
      codeOf(
        await asOwner.attempt(
          `mutation { updateOrganisation(input: { name: null }) { name } }`,
        ),
      ),
    ).toBe("validation.errors.invalid-input");
  });
});
