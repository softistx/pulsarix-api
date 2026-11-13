import { describe, expect, spyOn, test } from "bun:test";
import {
  authApp,
  ownerWithOrganisation,
  signedUp,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";
import { codeOf } from "~/http";
import { coreMongo } from "../../config/db";
import { addressKey } from "../shared/address";
import { AcceptanceService } from "./invitations.acceptance";
import { sha256 } from "./invitations.token";

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
});

describe("the per-address limits of the anonymous mutations", () => {
  const limit = (allowed: () => boolean, keys: string[]) => ({
    consume: async (params: { ip: string }) => {
      keys.push(params.ip);
      return { allowed: allowed(), retryAfter: 90_000 };
    },
  });
  const unused = {
    organisationCreate: {
      consume: async () => ({ allowed: true, retryAfter: 0 }),
    },
  };

  test("sign-up and acceptInvitation are refused 429 past their limit", async () => {
    let open = true;
    const signUpKeys: string[] = [];
    const acceptKeys: string[] = [];
    const limited = authApp({
      limits: {
        ...unused,
        signUpIp: limit(() => open, signUpKeys),
        acceptInvitationIp: limit(() => open, acceptKeys),
      },
    });
    const SignUp = `mutation($input: SignUpInput!) {
      signUp(input: $input) { status }
    }`;
    const input = {
      email: uniqueEmail("limited"),
      password: specPassword,
      name: "Limited",
    };
    await limited.client().call(SignUp, { input });
    // Specs have no connection address: the key is addressKey(ctx.ip), and a
    // forged x-forwarded-for from an untrusted peer does not change it.
    expect(signUpKeys).toEqual([addressKey(undefined)]);
    await limited
      .client(null, {
        headers: { "x-forwarded-for": "198.51.100.1" },
      })
      .attempt(SignUp, {
        input: { ...input, email: uniqueEmail("forged") },
      });
    expect(signUpKeys).toEqual([addressKey(undefined), addressKey(undefined)]);
    open = false;
    expect(
      codeOf(
        await limited
          .client()
          .attempt(SignUp, { input: { ...input, email: uniqueEmail("l2") } }),
      ),
    ).toBe("auth.errors.too-many-attempts");
    expect(
      codeOf(
        await limited
          .client()
          .attempt(Accept, { token: "x", password: specPassword }),
      ),
    ).toBe("auth.errors.too-many-attempts");
    expect(acceptKeys).toEqual([addressKey(undefined)]);
  });

  test("a limiter that throws is a 503, never a free pass", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const down = {
        consume: async () => {
          throw new Error("redis down");
        },
      };
      const broken = authApp({
        limits: { ...unused, signUpIp: down, acceptInvitationIp: down },
      });
      const refused = await broken
        .client()
        .attempt(
          `mutation($input: SignUpInput!) { signUp(input: $input) { status } }`,
          {
            input: {
              email: uniqueEmail("down"),
              password: specPassword,
              name: "Down",
            },
          },
        );
      expect(codeOf(refused)).toBe("auth.errors.unavailable");
      expect(
        codeOf(
          await broken
            .client()
            .attempt(Accept, { token: "x", password: specPassword }),
        ),
      ).toBe("auth.errors.unavailable");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a failed grant puts the invitation back", () => {
  // The real acceptance, over a core whose put-back (`update` to PENDING) fails
  // `failures` times, and a membership whose `assign` always fails.
  const flaky = (failures: number) => {
    let left = failures;
    const core = {
      db: coreMongo.db,
      as: (accountId: string) => {
        const invitations = coreMongo.as(accountId).db.invitations;
        return {
          db: {
            invitations: {
              findById: (id: Parameters<typeof invitations.findById>[0]) =>
                invitations.findById(id),
              update: async (
                id: Parameters<typeof invitations.update>[0],
                patch: Parameters<typeof invitations.update>[1],
              ) => {
                if (patch.status === "PENDING" && left > 0) {
                  left--;
                  throw new Error("connection dropped");
                }
                return invitations.update(id, patch);
              },
            },
          },
        };
      },
    } as unknown as ConstructorParameters<typeof AcceptanceService>[0];
    const membership = new Proxy(kit.auth.membership, {
      get(target, key) {
        if (key === "assign") {
          return async () => {
            throw new Error("grant failed");
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { core, membership };
  };

  const attempt = async (failures: number) => {
    const { owner, organisation } = await ownerWithOrganisation(kit);
    const email = uniqueEmail("release");
    await kit
      .client(owner.token, { organisation: organisation.id })
      .call(Invite, { input: { email, name: "Rel", role: "member" } });
    const token = tokenSent(kit, email, "invitation");
    const { core, membership } = flaky(failures);
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    const logged: string[] = [];
    const service = new AcceptanceService(
      core,
      { accounts: kit.auth.accounts, membership, clock: kit.auth.clock },
      "en",
      (message) => logged.push(message),
    );
    try {
      await expect(service.accept(token, specPassword)).rejects.toThrow(
        "grant failed",
      );
    } finally {
      log.mockRestore();
    }
    const stored = await coreMongo.db.invitations.findFirst({
      tokenHash: sha256(token),
    });
    return { status: stored?.status, logged };
  };

  test("one failed put-back is retried and the invitation stays PENDING", async () => {
    const { status, logged } = await attempt(1);
    expect(status).toBe("PENDING");
    expect(logged).toEqual([]);
  });

  test("two failed put-backs are logged and the invitation stays ACCEPTED", async () => {
    const { status, logged } = await attempt(2);
    expect(status).toBe("ACCEPTED");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("could not put it back to PENDING");
  });
});
