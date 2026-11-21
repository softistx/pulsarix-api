import { expect } from "bun:test";
import {
  type AuthApp,
  ownerWithOrganisation,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";

export const Invite = `mutation($input: InviteMemberInput!) {
  inviteMember(input: $input) { id email role status }
}`;
export const Accept = `mutation($token: String!, $password: String) {
  acceptInvitation(token: $token, password: $password) {
    linked
    signIn { status session { token viewer { id email name } } }
  }
}`;
export const Members = `{ members { id name email role isViewer } }`;
export const ChangeRole = `mutation($id: ID!, $role: Role!) {
  changeMemberRole(id: $id, role: $role) { id role }
}`;

export async function invitePerson(kit: AuthApp) {
  // Sign-up, then an organisation: the account owns it. The owner invites a
  // person who has no account yet.
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  expect(
    (await asOwner.call<{ members: { role: string }[] }>(Members)).members,
  ).toMatchObject([{ role: "owner", isViewer: true }]);
  const email = uniqueEmail("grace");
  const invited = await asOwner.call<{
    inviteMember: { id: string; status: string };
  }>(Invite, { input: { email, name: "Grace Hopper", role: "member" } });
  expect(invited.inviteMember.status).toBe("PENDING");
  return {
    asOwner,
    email,
    organisationId: organisation.id,
    token: tokenSent(kit, email, "invitation"),
  };
}

export async function acceptedMember(kit: AuthApp) {
  const invite = await invitePerson(kit);
  const accepted = await kit.client().call<{
    acceptInvitation: {
      signIn: { session: { token: string; viewer: { id: string } } };
    };
  }>(Accept, { token: invite.token, password: specPassword });
  const session = accepted.acceptInvitation.signIn.session;
  return {
    ...invite,
    grace: session.viewer,
    asGrace: kit.client(session.token, { organisation: invite.organisationId }),
  };
}
