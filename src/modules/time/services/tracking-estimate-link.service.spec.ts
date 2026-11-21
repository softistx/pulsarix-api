import { beforeAll, describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import {
  factory,
  fake,
  KEY,
  kit,
  Link,
  setup,
  TimeLink,
  Unlink,
  Update,
  useFake,
} from "~/time-tracking";
import { useChronix } from "../chronix.client";

beforeAll(() => useChronix(factory));

describe("the estimate", () => {
  test("is set on create, changed and cleared on update, and bounded", async () => {
    const { asOwner, make } = await setup(false);
    const issue = await make("Estimated", { estimateHours: 2.5 });
    expect(issue.estimateHours).toBe(2.5);
    const set = await asOwner.call<{ updateIssue: { estimateHours: number } }>(
      Update,
      { id: issue.id, input: { estimateHours: 8 } },
    );
    expect(set.updateIssue.estimateHours).toBe(8);
    const cleared = await asOwner.call<{
      updateIssue: { estimateHours: number | null };
    }>(Update, { id: issue.id, input: { estimateHours: null } });
    expect(cleared.updateIssue.estimateHours).toBeNull();
    const refused = await asOwner.attempt(Update, {
      id: issue.id,
      input: { estimateHours: -1 },
    });
    expect(codeOf(refused)).toBe("validation.errors.invalid-input");
    expect((await make("Plain")).estimateHours).toBeNull();
  });
});

describe("the organisation's link", () => {
  test("an admin links it; only linked and the chronix name come back", async () => {
    const { asOwner, asMember } = await setup(false);
    expect(
      (await asOwner.call<{ timeLink: unknown }>(TimeLink)).timeLink,
    ).toEqual({ linked: false, organisationName: null });
    const linked = await asOwner.call<{ linkChronix: unknown }>(Link, {
      key: KEY,
    });
    expect(linked.linkChronix).toEqual({
      linked: true,
      organisationName: "Acme Time",
    });
    // A member reads it, and the key is not a field of the schema at all.
    expect(
      (await asMember.call<{ timeLink: { linked: boolean } }>(TimeLink))
        .timeLink.linked,
    ).toBe(true);
    const probe = await asOwner.attempt(`{ timeLink { sealedKey key } }`);
    expect(probe.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(linked)).not.toContain(KEY);
  });

  test("a member cannot link or unlink; a refused key is 400 invalid-key", async () => {
    const { asOwner, asMember, asViewer } = await setup(false);
    expect(codeOf(await asMember.attempt(Link, { key: KEY }))).toBe(
      "auth.errors.forbidden",
    );
    expect(codeOf(await asViewer.attempt(Unlink))).toBe(
      "auth.errors.forbidden",
    );
    const bad = await asOwner.attempt(Link, { key: "chx_link_wrong" });
    expect(codeOf(bad)).toBe("time.errors.invalid-key");
    // Empty: refused by the input schema. Blank: refused by the guard before
    // anything is sent or sealed.
    expect(codeOf(await asOwner.attempt(Link, { key: "" }))).toBe(
      "validation.errors.invalid-input",
    );
    expect(codeOf(await asOwner.attempt(Link, { key: "   " }))).toBe(
      "time.errors.invalid-key",
    );
    expect(
      (await asOwner.call<{ timeLink: { linked: boolean } }>(TimeLink)).timeLink
        .linked,
    ).toBe(false);
  });

  test("a key made for another application or organisation is refused", async () => {
    const { asOwner, organisation } = await setup(false);
    // chronix answers the link of another application, then of another
    // organisation, for the key it was given.
    for (const other of [
      { partnerApp: "operix" },
      { partnerOrganisationId: "someone-else" },
    ]) {
      useFake(organisation.id, other);
      expect(codeOf(await asOwner.attempt(Link, { key: KEY }))).toBe(
        "time.errors.key-mismatch",
      );
    }
    // A key issued for nobody here is refused by chronix itself.
    useFake(organisation.id);
    expect(codeOf(await asOwner.attempt(Link, { key: "chx_link_other" }))).toBe(
      "time.errors.invalid-key",
    );
    expect(
      (await asOwner.call<{ timeLink: { linked: boolean } }>(TimeLink)).timeLink
        .linked,
    ).toBe(false);
  });

  test("linking and unlinking ask for a fresh session", async () => {
    const { asOwner } = await setup(false);
    kit.clock.advance(11 * 60 * 1000);
    expect(codeOf(await asOwner.attempt(Link, { key: KEY }))).toBe(
      "auth.errors.step-up-required",
    );
    expect(codeOf(await asOwner.attempt(Unlink))).toBe(
      "auth.errors.step-up-required",
    );
  });

  test("linking while chronix is down is 503, and unlinking forgets the key", async () => {
    const { asOwner } = await setup(false);
    fake.goDown();
    expect(codeOf(await asOwner.attempt(Link, { key: KEY }))).toBe(
      "time.errors.unavailable",
    );
    fake.comeUp();
    await asOwner.call(Link, { key: KEY });
    const gone = await asOwner.call<{ unlinkChronix: { linked: boolean } }>(
      Unlink,
    );
    expect(gone.unlinkChronix.linked).toBe(false);
  });
});
