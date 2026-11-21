import { describe, expect, test } from "bun:test";
import {
  authApp,
  ownerWithOrganisation,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";
import { codeOf } from "~/http";
import {
  Accept,
  acceptedMember,
  ChangeRole,
  Invite,
  invitePerson,
  Members,
} from "~/invitations";

const kit = authApp();

describe("sign-up, invite, accept, role change", () => {
  test("an invited person accepts once and is signed in", async () => {
    const { asOwner, email, token } = await invitePerson(kit);

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
        signIn: { session: { viewer: { name: string } } };
      };
    }>(Accept, { token, password: specPassword });
    expect(accepted.acceptInvitation.linked).toBe(false);
    expect(accepted.acceptInvitation.signIn.session.viewer.name).toBe(
      "Grace Hopper",
    );

    // The token is spent.
    expect(
      codeOf(
        await anonymous.attempt(Accept, { token, password: specPassword }),
      ),
    ).toBe("invitations.errors.invalid");
    expect(
      (await asOwner.call<{ members: unknown[] }>(Members)).members,
    ).toHaveLength(2);
  });

  test("a new member cannot manage, and a role change shows at once", async () => {
    const { asOwner, asGrace, grace, organisationId } =
      await acceptedMember(kit);
    expect(organisationId).toBeString();

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
        await asGrace.attempt(ChangeRole, { id: grace.id, role: "admin" }),
      ),
    ).toBe("auth.errors.forbidden");

    // The owner changes the role; the change shows at once.
    const changed = await asOwner.call<{ changeMemberRole: { role: string } }>(
      ChangeRole,
      { id: grace.id, role: "admin" },
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
});
