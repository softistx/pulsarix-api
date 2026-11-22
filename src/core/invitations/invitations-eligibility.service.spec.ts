import { describe, expect, test } from "bun:test";
import {
  authApp,
  ownerWithOrganisation,
  signedUp,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";
import { codeOf } from "~/http";
import { Accept, Invite } from "~/invitations";

const kit = authApp();

describe("sign-up, invite, accept, role change", () => {
  test("an existing account is linked, an expired link is refused, a member cannot be invited", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    const existing = await signedUp(kit, "Existing Person");
    // Its e-mail was never proved, so the invitation proves it and needs the password.
    await asOwner.call(Invite, {
      input: { email: existing.email, name: "Existing", role: "viewer" },
    });
    const token = tokenSent(kit, existing.email, "invitation");
    const anonymous = kit.client();
    expect(codeOf(await anonymous.attempt(Accept, { token }))).toBe(
      "validation.errors.invalid-input",
    );
    const accepted = await anonymous.call<{
      acceptInvitation: { signIn: { session: { viewer: { id: string } } } };
    }>(Accept, { token, password: specPassword });
    expect(accepted.acceptInvitation.signIn.session.viewer.id).toBe(
      existing.id,
    );

    // A member cannot be invited again.
    expect(
      codeOf(
        await asOwner.attempt(Invite, {
          input: { email: existing.email, name: "Existing", role: "member" },
        }),
      ),
    ).toBe("invitations.errors.address-already-member");

    // Now that the e-mail is proved, a second organisation's invitation links the account.
    const other = await ownerWithOrganisation(kit, "Other Org");
    const asOther = kit.client(other.owner.token, {
      organisation: other.organisation.id,
    });
    await asOther.call(Invite, {
      input: { email: existing.email, name: "Existing", role: "member" },
    });
    const second = tokenSent(kit, existing.email, "invitation");
    const linked = await anonymous.call<{
      acceptInvitation: { linked: boolean; signIn: unknown };
    }>(Accept, {
      token: second,
    });
    expect(linked.acceptInvitation).toEqual({ linked: true, signIn: null });
    expect(codeOf(await anonymous.attempt(Accept, { token: second }))).toBe(
      "invitations.errors.invalid",
    );

    // An expired link is refused.
    const late = uniqueEmail("late");
    await asOwner.call(Invite, {
      input: { email: late, name: "Late", role: "viewer" },
    });
    kit.clock.advance(8 * 24 * 60 * 60 * 1000);
    expect(
      codeOf(
        await anonymous.attempt(Accept, {
          token: tokenSent(kit, late, "invitation"),
          password: specPassword,
        }),
      ),
    ).toBe("invitations.errors.invalid");
  });

  test("only an owner invites an owner", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    const email = uniqueEmail("admin");
    await asOwner.call(Invite, {
      input: { email, name: "Admin", role: "admin" },
    });
    const accepted = await kit
      .client()
      .call<{ acceptInvitation: { signIn: { session: { token: string } } } }>(
        Accept,
        {
          token: tokenSent(kit, email, "invitation"),
          password: specPassword,
        },
      );
    const asAdmin = kit.client(accepted.acceptInvitation.signIn.session.token, {
      organisation: organisation.id,
    });
    const refused = await asAdmin.attempt(Invite, {
      input: { email: uniqueEmail(), name: "O", role: "owner" },
    });
    expect(codeOf(refused)).toBe("members.errors.owner-required");
    // An admin invites a member.
    await asAdmin.call(Invite, {
      input: { email: uniqueEmail(), name: "M", role: "member" },
    });
  });

  test("inviting asks for a recent proof of identity (step-up)", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    kit.clock.advance(11 * 60 * 1000);
    expect(
      codeOf(
        await asOwner.attempt(Invite, {
          input: {
            email: uniqueEmail("stale"),
            name: "Stale Invite",
            role: "member",
          },
        }),
      ),
    ).toBe("auth.errors.step-up-required");
  });

  test("listing the pending invitations needs no recent proof", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    await asOwner.call(Invite, {
      input: { email: uniqueEmail("listed"), name: "Listed", role: "member" },
    });
    kit.clock.advance(11 * 60 * 1000);
    const listed = await asOwner.call<{ invitations: { id: string }[] }>(
      `{ invitations(status: PENDING) { id } }`,
    );
    expect(listed.invitations).toHaveLength(1);
  });
});
