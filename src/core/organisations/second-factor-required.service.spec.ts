import { describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation, proveEmail } from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();

const Require = `mutation($required: Boolean!) {
  setSecondFactorRequired(required: $required) { requireSecondFactor }
}`;
const Read = `{ organisation { id requireSecondFactor viewerPermissions } }`;
const Members = `{ members { id } }`;

// Enrols and activates a TOTP second factor for the account holding `token`.
async function enrol(account: { token: string; email: string }) {
  await proveEmail(kit, account.email);
  const asAccount = kit.client(account.token);
  const { enrollSecondFactor } = await asAccount.call<{
    enrollSecondFactor: { secret: string };
  }>(`mutation { enrollSecondFactor { secret } }`);
  await asAccount.call(
    `mutation($code: String!) { activateSecondFactor(code: $code) { codes } }`,
    { code: kit.code(enrollSecondFactor.secret) },
  );
}

describe("the second factor required per organisation", () => {
  test("an owner turns it on behind a step-up, and needs their own factor", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const asOwner = kit.client(owner.token, { organisation: organisation.id });

    // The owner without a factor of their own would lock themselves out.
    expect(codeOf(await asOwner.attempt(Require, { required: true }))).toBe(
      "auth.errors.second-factor-not-enrolled",
    );
    await enrol(owner);

    // A stale session is asked for a step-up first.
    kit.clock.advance(11 * 60 * 1000);
    expect(codeOf(await asOwner.attempt(Require, { required: true }))).toBe(
      "auth.errors.step-up-required",
    );
  });

  test("a member without TOTP cannot read until they enrol; enrolling reopens it", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const admin = await memberWith(kit, organisation.id, owner.token, "admin");
    const member = await memberWith(
      kit,
      organisation.id,
      owner.token,
      "member",
    );
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    const asAdmin = kit.client(admin.token, { organisation: organisation.id });
    const asMember = kit.client(member.token, {
      organisation: organisation.id,
    });

    // Off by default: everyone reads.
    expect(
      (
        await asMember.call<{ organisation: { requireSecondFactor: boolean } }>(
          Read,
        )
      ).organisation.requireSecondFactor,
    ).toBe(false);

    await enrol(owner);
    const on = await asOwner.call<{
      setSecondFactorRequired: { requireSecondFactor: boolean };
    }>(Require, { required: true });
    expect(on.setSecondFactorRequired.requireSecondFactor).toBe(true);

    // The owner has a factor and still reads; the others are refused on every
    // organisation read, whatever their role.
    expect(
      (await asOwner.call<{ organisation: { id: string } }>(Read)).organisation
        .id,
    ).toBe(organisation.id);
    for (const client of [asMember, asAdmin]) {
      expect(codeOf(await client.attempt(Read))).toBe(
        "auth.errors.second-factor-required",
      );
      expect(codeOf(await client.attempt(Members))).toBe(
        "auth.errors.second-factor-required",
      );
    }
    // An admin without a factor cannot turn it off either.
    expect(codeOf(await asAdmin.attempt(Require, { required: false }))).toBe(
      "auth.errors.second-factor-required",
    );

    // Account-level calls stay open: the switcher, and the enrolment itself.
    const mine = await asMember.call<{
      myOrganisations: { organisation: { requireSecondFactor: boolean } }[];
    }>(`{ myOrganisations { organisation { requireSecondFactor } } }`);
    expect(mine.myOrganisations[0]?.organisation.requireSecondFactor).toBe(
      true,
    );
    await enrol(member);
    expect(
      (await asMember.call<{ organisation: { id: string } }>(Read)).organisation
        .id,
    ).toBe(organisation.id);
    expect(codeOf(await asAdmin.attempt(Read))).toBe(
      "auth.errors.second-factor-required",
    );

    // The owner turns it off: the admin reads again without a factor.
    await asOwner.call(Require, { required: false });
    expect(
      (await asAdmin.call<{ organisation: { id: string } }>(Read)).organisation
        .id,
    ).toBe(organisation.id);
  });

  test("a member cannot toggle it, and only the owner holds member:assign_owner", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const admin = await memberWith(kit, organisation.id, owner.token, "admin");
    const member = await memberWith(
      kit,
      organisation.id,
      owner.token,
      "member",
    );
    const asMember = kit.client(member.token, {
      organisation: organisation.id,
    });
    expect(codeOf(await asMember.attempt(Require, { required: true }))).toBe(
      "auth.errors.forbidden",
    );
    const permissionsOf = async (token: string) =>
      (
        await kit
          .client(token, { organisation: organisation.id })
          .call<{ organisation: { viewerPermissions: string[] } }>(Read)
      ).organisation.viewerPermissions;
    expect(await permissionsOf(owner.token)).toContain("member:assign_owner");
    expect(await permissionsOf(admin.token)).not.toContain(
      "member:assign_owner",
    );
  });
});
