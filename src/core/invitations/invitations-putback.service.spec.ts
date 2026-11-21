import { describe, expect, spyOn, test } from "bun:test";
import {
  authApp,
  ownerWithOrganisation,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";
import { Invite } from "~/invitations";
import { coreMongo } from "../../config/db";
import { AcceptanceService } from "./invitations.acceptance";
import { sha256 } from "./invitations.token";

const kit = authApp();

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
