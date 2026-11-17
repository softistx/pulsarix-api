import { describe, expect, test } from "bun:test";
import { authApp, tokenSent, uniqueEmail } from "~/auth";
import { coreMongo, tenancy } from "../config/db";
import { SYSTEM_ACTOR } from "../core/shared/actors";
import { parseBootstrapArgs } from "./bootstrap";
import { bootstrapOrganisation } from "./bootstrap-organisation";

const kit = authApp();
const deps = { core: coreMongo, tenancy, auth: kit.auth };

describe("parseBootstrapArgs", () => {
  const base = [
    "--organisation",
    "Acme",
    "--invite",
    "a@b.test",
    "--name",
    "Ada",
  ];
  test("defaults to an owner, in English", () => {
    expect(parseBootstrapArgs(base)).toMatchObject({
      organisation: "Acme",
      email: "a@b.test",
      role: "owner",
      locale: "en",
    });
  });
  test("refuses missing, bad role and bad address", () => {
    expect(() => parseBootstrapArgs(["--organisation", "x"])).toThrow(
      /missing/,
    );
    expect(() => parseBootstrapArgs([...base, "--role", "god"])).toThrow(
      /role/,
    );
    expect(() =>
      parseBootstrapArgs([
        "--organisation",
        "x",
        "--invite",
        "nope",
        "--name",
        "n",
      ]),
    ).toThrow(/e-mail/);
  });
});

describe("bootstrapOrganisation", () => {
  test("provisions without an account, mails, and is idempotent", async () => {
    const slug = `boot-${Date.now().toString(36)}`;
    const email = uniqueEmail("boot");
    const input = {
      organisation: "Boot Org",
      slug,
      email,
      name: "Boot Owner",
      role: "owner" as const,
      locale: "en" as const,
    };
    const first = await bootstrapOrganisation(deps, input);
    expect(first.created).toBe(true);
    expect(first.organisation.status).toBe("active");
    expect(first.organisation.createdBy).toBe(SYSTEM_ACTOR);
    expect(first.invitation).toMatchObject({
      role: "owner",
      status: "PENDING",
    });
    const firstToken = tokenSent(kit, email, "invitation");

    const second = await bootstrapOrganisation(deps, input);
    expect(second.created).toBe(false);
    expect(second.organisation._id.equals(first.organisation._id)).toBe(true);
    const all = await coreMongo.db.invitations.findMany({
      filter: { organisationId: first.organisation._id, email },
    });
    expect(all.filter((i) => i.status === "PENDING")).toHaveLength(1);
    expect(all.filter((i) => i.status === "REVOKED")).toHaveLength(1);
    expect(tokenSent(kit, email, "invitation")).not.toBe(firstToken);
  }, 30_000);

  test("refuses a reused slug whose organisation is not active", async () => {
    const slug = `boot-arch-${Date.now().toString(36)}`;
    const input = {
      organisation: "Arch",
      slug,
      email: uniqueEmail("arch"),
      name: "A",
      role: "admin" as const,
      locale: "fr" as const,
    };
    const { organisation } = await bootstrapOrganisation(deps, input);
    await coreMongo.as(SYSTEM_ACTOR).db.organisations.update(organisation._id, {
      status: "archived",
      version: organisation.version,
    });
    await expect(bootstrapOrganisation(deps, input)).rejects.toThrow(
      /archived/,
    );
  }, 30_000);
});
