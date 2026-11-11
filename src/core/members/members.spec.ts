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

const ChangeRole = `mutation($id: ID!, $role: Role!) {
  changeMemberRole(id: $id, role: $role) { id role }
}`;
const Remove = `mutation($id: ID!) { removeMember(id: $id) }`;
const Invite = `mutation($input: InviteMemberInput!) { inviteMember(input: $input) { id } }`;
const Accept = `mutation($token: String!, $password: String) {
  acceptInvitation(token: $token, password: $password) { signIn { session { token viewer { id } } } }
}`;
const Members = `{ members { id role } }`;

// A member of the organisation with `role`, invited and accepted through the API.
async function memberWith(
  organisation: string,
  ownerToken: string,
  role: "owner" | "admin" | "member" | "viewer",
) {
  const email = uniqueEmail(role);
  await kit.client(ownerToken, { organisation }).call(Invite, {
    input: { email, name: role, role },
  });
  const accepted = await kit.client().call<{
    acceptInvitation: {
      signIn: { session: { token: string; viewer: { id: string } } };
    };
  }>(Accept, {
    token: tokenSent(kit, email, "invitation"),
    password: specPassword,
  });
  const { token, viewer } = accepted.acceptInvitation.signIn.session;
  return { id: viewer.id, token };
}

describe("roles", () => {
  test("a viewer reads, a member reads, neither manages", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const viewer = await memberWith(organisation.id, owner.token, "viewer");
    const asViewer = kit.client(viewer.token, {
      organisation: organisation.id,
    });
    expect(
      (await asViewer.call<{ members: unknown[] }>(Members)).members,
    ).toHaveLength(2);
    expect(
      codeOf(
        await asViewer.attempt(ChangeRole, { id: owner.id, role: "viewer" }),
      ),
    ).toBe("auth.errors.forbidden");
    const perms = await asViewer.call<{
      organisation: { viewerPermissions: string[] };
    }>(`{ organisation { viewerPermissions } }`);
    expect(perms.organisation.viewerPermissions).toEqual([
      "organisation:read",
      "member:read",
    ]);
  });

  test("an organisation keeps its last owner", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    expect(
      codeOf(
        await asOwner.attempt(ChangeRole, { id: owner.id, role: "admin" }),
      ),
    ).toBe("members.errors.last-owner");
    expect(codeOf(await asOwner.attempt(Remove, { id: owner.id }))).toBe(
      "members.errors.last-owner",
    );

    // With a second owner the first may step down, then the second is the last.
    const second = await memberWith(organisation.id, owner.token, "owner");
    await asOwner.call(ChangeRole, { id: owner.id, role: "admin" });
    const asSecond = kit.client(second.token, {
      organisation: organisation.id,
    });
    expect(codeOf(await asSecond.attempt(Remove, { id: second.id }))).toBe(
      "members.errors.last-owner",
    );
  });

  test("two owners stepping down together leave one", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const second = await memberWith(organisation.id, owner.token, "owner");
    const asFirst = kit.client(owner.token, { organisation: organisation.id });
    const asSecond = kit.client(second.token, {
      organisation: organisation.id,
    });
    const results = await Promise.all([
      asFirst.attempt(ChangeRole, { id: owner.id, role: "member" }),
      asSecond.attempt(ChangeRole, { id: second.id, role: "member" }),
    ]);
    const refused = results.filter((r) => r.errors);
    expect(refused).toHaveLength(1);
    expect(["members.errors.last-owner", "auth.errors.forbidden"]).toContain(
      codeOf(refused[0] ?? {}) ?? "",
    );
    const owners = (
      await kit
        .client(owner.token, { organisation: organisation.id })
        .call<{ members: { role: string }[] }>(Members)
    ).members.filter((m) => m.role === "owner");
    expect(owners).toHaveLength(1);
  });

  test("only an owner touches the owner role; an admin manages the others", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const admin = await memberWith(organisation.id, owner.token, "admin");
    const member = await memberWith(organisation.id, owner.token, "member");
    const asAdmin = kit.client(admin.token, { organisation: organisation.id });
    expect(
      codeOf(
        await asAdmin.attempt(ChangeRole, { id: member.id, role: "owner" }),
      ),
    ).toBe("members.errors.owner-required");
    expect(
      codeOf(
        await asAdmin.attempt(ChangeRole, { id: owner.id, role: "member" }),
      ),
    ).toBe("members.errors.owner-required");
    expect(codeOf(await asAdmin.attempt(Remove, { id: owner.id }))).toBe(
      "members.errors.owner-required",
    );
    const done = await asAdmin.call<{ changeMemberRole: { role: string } }>(
      ChangeRole,
      {
        id: member.id,
        role: "viewer",
      },
    );
    expect(done.changeMemberRole.role).toBe("viewer");
    // Removing a member takes their access away at once.
    await asAdmin.call(Remove, { id: member.id });
    const asRemoved = kit.client(member.token, {
      organisation: organisation.id,
    });
    expect(codeOf(await asRemoved.attempt(Members))).toBe(
      "tenancy.errors.unknown-organization",
    );
    expect(codeOf(await asAdmin.attempt(Remove, { id: member.id }))).toBe(
      "members.errors.not-found",
    );
  });

  test("a role change asks for a recent proof of identity (step-up)", async () => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const member = await memberWith(organisation.id, owner.token, "member");
    const asOwner = kit.client(owner.token, { organisation: organisation.id });
    kit.clock.advance(11 * 60 * 1000);
    const stale = await asOwner.attempt(ChangeRole, {
      id: member.id,
      role: "viewer",
    });
    expect(codeOf(stale)).toBe("auth.errors.step-up-required");

    // A code is mailed, and confirming it makes the session fresh again.
    const challenge = await asOwner.call<{
      requestStepUp: { challenge: string; via: string };
    }>(`mutation { requestStepUp { challenge via } }`);
    expect(challenge.requestStepUp.via).toBe("EMAIL");
    await kit.settled();
    const mail = kit.outbox.sent.findLast((sent) =>
      JSON.stringify(sent.to).includes(owner.email),
    );
    const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeDefined();
    const wrong = await asOwner.attempt(
      `mutation($c: String!, $code: String!) { confirmStepUp(challenge: $c, code: $code) }`,
      {
        c: challenge.requestStepUp.challenge,
        code: "000000",
      },
    );
    expect(codeOf(wrong)).toBe("auth.errors.invalid-code");
    await asOwner.call(
      `mutation($c: String!, $code: String!) { confirmStepUp(challenge: $c, code: $code) }`,
      {
        c: challenge.requestStepUp.challenge,
        code,
      },
    );
    const done = await asOwner.call<{ changeMemberRole: { role: string } }>(
      ChangeRole,
      {
        id: member.id,
        role: "viewer",
      },
    );
    expect(done.changeMemberRole.role).toBe("viewer");
  });

  test("an account that is not signed in or not a member is refused", async () => {
    const { organisation } = await ownerWithOrganisation(kit);
    expect(
      codeOf(
        await kit
          .client(null, { organisation: organisation.id })
          .attempt(Members),
      ),
    ).toBe("auth.errors.unauthenticated");
    const stranger = await signedUp(kit, "Stranger");
    expect(
      codeOf(
        await kit
          .client(stranger.token, { organisation: organisation.id })
          .attempt(Members),
      ),
    ).toBe("tenancy.errors.unknown-organization");
    expect(codeOf(await kit.client(stranger.token).attempt(Members))).toBe(
      "tenancy.errors.organization-required",
    );
  });
});
