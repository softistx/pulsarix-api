import { describe, expect, test } from "bun:test";
import { defineModule } from "@alxia/modules";
import { dbOf } from "@alxia/tenancy";
import { defineCollection, id } from "@softistx/mongo";
import { z } from "zod";
import { authApp, ownerWithOrganisation } from "~/auth";
import { coreMongo, tenancyOf } from "../../config/db";
import { modules } from "../../modules/registry";
import { actors } from "../shared/actors";

// A test-only organisation collection: A1 declares none of its own yet (projects
// arrive with A2), and the isolation needs one that lives in an organisation's
// database.
const notes = defineCollection({
  name: "notes",
  schema: z.object({ _id: id(), text: z.string().min(1) }),
  timestamps: true,
  actors,
  indexes: [{ key: { text: 1 }, name: "notes_text" }],
});
const notesModule = defineModule({ name: "notes", collections: { notes } });

const kit = authApp();

describe("a database per organisation", () => {
  test("each organisation has its own database, and its data stays there", async () => {
    const a = await ownerWithOrganisation(kit, "Isolated A");
    const b = await ownerWithOrganisation(kit, "Isolated B");
    const store = tenancyOf(kit.auth.membership, [...modules, notesModule]);
    try {
      const request = (organisation: string) =>
        new Request("https://api.pulsarix.test/graphql", {
          headers: { "x-organization-id": organisation },
        });
      const ownerA = { id: a.owner.id };
      const ownerB = { id: b.owner.id };

      const scopeA = await store.scope(request(a.organisation.id), ownerA);
      const scopeB = await store.scope(request(b.organisation.id), ownerB);
      expect(scopeA.tenant.id).toBe(a.organisation.id);
      expect(scopeB.tenant.id).toBe(b.organisation.id);
      expect(scopeA.member).toBe("owner");

      await (
        scopeA.mongo.db as unknown as {
          notes: { create(d: object): Promise<unknown> };
        }
      ).notes.create({
        text: "secret of A",
      });
      const inA = await (
        scopeA.mongo.db as unknown as {
          notes: { count(f: object): Promise<number> };
        }
      ).notes.count({});
      const inB = await (
        scopeB.mongo.db as unknown as {
          notes: { count(f: object): Promise<number> };
        }
      ).notes.count({});
      expect([inA, inB]).toEqual([1, 0]);

      // Two databases, named by the organisation ids.
      const names = (
        await dbOf(coreMongo).client.db().admin().listDatabases()
      ).databases.map((d) => d.name);
      expect(names).toContain(`pulsarix_org_${a.organisation.id}`);
    } finally {
      await store.close();
    }
  });

  test("a viewer who is no member gets no scope, whatever they name", async () => {
    const a = await ownerWithOrganisation(kit, "Walled A");
    const b = await ownerWithOrganisation(kit, "Walled B");
    const store = tenancyOf(kit.auth.membership, [...modules, notesModule]);
    try {
      const into = (organisation: string) =>
        new Request("https://api.pulsarix.test/graphql", {
          headers: { "x-organization-id": organisation },
        });
      await expect(
        store.scope(into(b.organisation.id), { id: a.owner.id }),
      ).rejects.toMatchObject({
        code: "tenancy.errors.unknown-organization",
        status: 404,
      });
      await expect(
        store.scope(into(b.organisation.slug), { id: a.owner.id }),
      ).rejects.toMatchObject({
        code: "tenancy.errors.unknown-organization",
      });
      await expect(
        store.scope(into(a.organisation.id), null),
      ).rejects.toMatchObject({
        code: "tenancy.errors.unknown-organization",
      });
    } finally {
      await store.close();
    }
  });
});
