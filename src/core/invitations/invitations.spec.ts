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

const kit = authApp();

const Invite = `mutation($input: InviteMemberInput!) {
  inviteMember(input: $input) { id email role status }
}`;
const Accept = `mutation($token: String!, $password: String) {
  acceptInvitation(token: $token, password: $password) {
    linked
    signIn { status session { token viewer { id email name } } }
  }
}`;
const Members = `{ members { id name email role isViewer } }`;
const ChangeRole = `mutation($id: ID!, $role: Role!) {
  changeMemberRole(id: $id, role: $role) { id role }
}`;

describe("sign-up, invite, accept, role change", () => {
  test("the whole onboarding flow", async () => {
    // Sign-up, then an organisation: the account owns it.
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    expect(
      (await asOwner.call<{ members: { role: string }[] }>(Members)).members,
    ).toMatchObject([{ role: "owner", isViewer: true }]);

    // The owner invites a person who has no account yet.
    const email = uniqueEmail("grace");
    const invited = await asOwner.call<{
      inviteMember: { id: string; status: string };
    }>(Invite, { input: { email, name: "Grace Hopper", role: "member" } });
    expect(invited.inviteMember.status).toBe("PENDING");
    const token = tokenSent(kit, email, "invitation");

    // The mail is in English by default and carries the organisation's name.
    const mail = kit.outbox.sent.findLast((sent) =>
      JSON.stringify(sent.to).includes(email),
    );
    expect(mail?.subject).toBe("Invitation to join North Star on pulsarix");

    // Accepting needs a password for a new account, then signs it in.
    const anonymous = kit.client();
    const noPassword = await anonymous.attempt(Accept, { token });
    expect(codeOf(noPassword)).toBe("validation.errors.invalid-input");
    const accepted = await anonymous.call<{
      acceptInvitation: {
        linked: boolean;
        signIn: {
          status: string;
          session: { token: string; viewer: { id: string; name: string } };
        };
      };
    }>(Accept, { token, password: specPassword });
    expect(accepted.acceptInvitation.linked).toBe(false);
    const grace = accepted.acceptInvitation.signIn.session;
    expect(grace.viewer.name).toBe("Grace Hopper");

    // The token is spent.
    expect(
      codeOf(
        await anonymous.attempt(Accept, { token, password: specPassword }),
      ),
    ).toBe("invitations.errors.invalid");

    // The new member sees the organisation as a member, and cannot manage.
    const asGrace = kit.client(grace.token, { organisation: organisation.id });
    const seen = await asGrace.call<{
      members: { email: string; role: string }[];
    }>(Members);
    expect(seen.members.map((member) => member.role).sort()).toEqual([
      "member",
      "owner",
    ]);
    expect(
      codeOf(
        await asGrace.attempt(Invite, {
          input: { email: uniqueEmail(), name: "X", role: "viewer" },
        }),
      ),
    ).toBe("auth.errors.forbidden");
    expect(
      codeOf(
        await asGrace.attempt(ChangeRole, {
          id: grace.viewer.id,
          role: "admin",
        }),
      ),
    ).toBe("auth.errors.forbidden");

    // The owner changes the role; the change shows at once.
    const changed = await asOwner.call<{ changeMemberRole: { role: string } }>(
      ChangeRole,
      {
        id: grace.viewer.id,
        role: "admin",
      },
    );
    expect(changed.changeMemberRole.role).toBe("admin");
    const permissions = await asGrace.call<{
      organisation: { viewerPermissions: string[] };
    }>(`{ organisation { viewerPermissions } }`);
    expect(permissions.organisation.viewerPermissions).toContain(
      "member:manage",
    );
  });

  test("an invitation is revoked, resent and replaced", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    const email = uniqueEmail("alan");
    const first = await asOwner.call<{ inviteMember: { id: string } }>(Invite, {
      input: { email, name: "Alan", role: "viewer" },
    });
    const oldToken = tokenSent(kit, email, "invitation");

    // Inviting the address again replaces the pending one: the old link ends.
    await asOwner.call(Invite, {
      input: { email, name: "Alan", role: "member" },
    });
    const newToken = tokenSent(kit, email, "invitation");
    expect(newToken).not.toBe(oldToken);
    const anonymous = kit.client();
    expect(
      codeOf(
        await anonymous.attempt(Accept, {
          token: oldToken,
          password: specPassword,
        }),
      ),
    ).toBe("invitations.errors.invalid");
    const listed = await asOwner.call<{
      invitations: { status: string; role: string }[];
    }>(`{ invitations { status role } }`);
    expect(
      listed.invitations.map((i) => `${i.status}:${i.role}`).sort(),
    ).toEqual(["PENDING:member", "REVOKED:viewer"]);

    // Revoking a revoked one is refused; a pending one is revoked and cannot be accepted.
    expect(
      codeOf(
        await asOwner.attempt(
          `mutation($id: ID!) { revokeInvitation(id: $id) { id } }`,
          { id: first.inviteMember.id },
        ),
      ),
    ).toBe("invitations.errors.not-pending");
    const pending = (
      await asOwner.call<{ invitations: { id: string }[] }>(
        `{ invitations(status: PENDING) { id } }`,
      )
    ).invitations[0];
    await asOwner.call(
      `mutation($id: ID!) { revokeInvitation(id: $id) { id } }`,
      { id: pending?.id },
    );
    expect(
      codeOf(
        await anonymous.attempt(Accept, {
          token: newToken,
          password: specPassword,
        }),
      ),
    ).toBe("invitations.errors.invalid");
  });

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
});
