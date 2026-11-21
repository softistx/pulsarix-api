import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { codeOf } from "~/http";
import {
  codeOfBody,
  countingLimits,
  goodReport,
  type IntakeKit,
  intakeKit,
} from "~/intake";
import { coreMongo, tenancy } from "../../../config/db";
import { IDENTITY_HEADER, reporterKeyOf } from "./identity.service";

const Generate = `mutation($keyId: ID!) {
  generateWidgetIdentitySecret(keyId: $keyId) {
    secret key { id identitySecretSetAt }
  }
}`;

const generate = async (kit: IntakeKit) =>
  (
    await kit.asOwner.call<{
      generateWidgetIdentitySecret: { secret: string };
    }>(Generate, { keyId: kit.key.id })
  ).generateWidgetIdentitySecret.secret;

const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

// What the host's server does: the payload segment, signed.
function token(
  secret: string,
  kit: IntakeKit,
  claims: Record<string, unknown> = {},
) {
  const iat = now();
  const body = b64(
    JSON.stringify({
      sub: "user-42",
      email: "ada@host.test",
      name: "Ada",
      aud: kit.key.publicKey,
      iat,
      exp: iat + 3600,
      ...claims,
    }),
  );
  const signature = createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64(signature)}`;
}

const reportsOf = async (kit: IntakeKit) => {
  const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
    db: {
      clientReports: {
        findMany: (q: object) => Promise<Record<string, unknown>[]>;
      };
    };
  };
  return mongo.db.clientReports.findMany({});
};

const identified = (kit: IntakeKit, value: string) =>
  kit.submit(goodReport(), { [IDENTITY_HEADER]: value });

describe("generateWidgetIdentitySecret", () => {
  test("shows the secret once and stores only its sealed form", async () => {
    const kit = await intakeKit();
    const secret = await generate(kit);
    expect(secret.length).toBeGreaterThanOrEqual(43);
    const stored = await coreMongo.db.widgetKeys.findFirst({
      publicKey: kit.key.publicKey,
    });
    expect(stored?.identitySecret).toBeString();
    expect(stored?.identitySecret).not.toContain(secret);
    expect(stored?.identitySecretSetAt).toBeInstanceOf(Date);
    const listed = await kit.asOwner.call<{
      widgetKeys: Record<string, unknown>[];
    }>(`query($p: ID!) { widgetKeys(projectId: $p) { identitySecretSetAt } }`, {
      p: kit.project.id,
    });
    expect(listed.widgetKeys[0]?.["identitySecretSetAt"]).toBeString();
    // No field returns the secret again.
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  test("asks for a recent proof of identity", async () => {
    const kit = await intakeKit();
    kit.kit.clock.advance(11 * 60_000);
    expect(
      codeOf(await kit.asOwner.attempt(Generate, { keyId: kit.key.id })),
    ).toBe("auth.errors.step-up-required");
  });

  test("a second call voids the first secret at once", async () => {
    const kit = await intakeKit();
    const first = await generate(kit);
    expect((await identified(kit, token(first, kit))).response.status).toBe(
      200,
    );
    const second = await generate(kit);
    expect(second).not.toBe(first);
    const old = await identified(kit, token(first, kit));
    expect(old.response.status).toBe(401);
    expect(codeOfBody(old.body)).toBe("intake.errors.identity-invalid");
    expect((await identified(kit, token(second, kit))).response.status).toBe(
      200,
    );
  });

  test("a member cannot generate one", async () => {
    const kit = await intakeKit();
    const anonymous = await kit.kit
      .client()
      .attempt(Generate, { keyId: kit.key.id });
    expect(codeOf(anonymous)).toBe("auth.errors.unauthenticated");
  });
});

describe("an identified report", () => {
  test("stores the reporter's digest, name and e-mail from the token", async () => {
    const kit = await intakeKit();
    const secret = await generate(kit);
    const { response } = await identified(kit, token(secret, kit));
    expect(response.status).toBe(200);
    const [report] = await reportsOf(kit);
    expect(report?.["reporterKey"]).toBe(reporterKeyOf(kit.key.id, "user-42"));
    expect(report?.["reporterKey"]).toHaveLength(64);
    expect(report?.["reporterName"]).toBe("Ada");
    expect(report?.["email"]).toBe("ada@host.test");
    // The raw user id is stored nowhere.
    expect(JSON.stringify(report)).not.toContain("user-42");
  });

  test("the same user under another key is another reporter", () => {
    expect(reporterKeyOf("a".repeat(24), "u")).not.toBe(
      reporterKeyOf("b".repeat(24), "u"),
    );
  });

  test("accepts a token 5 minutes ahead and one 5 minutes expired", async () => {
    const kit = await intakeKit();
    const secret = await generate(kit);
    const ahead = token(secret, kit, { iat: now() + 290, exp: now() + 3_000 });
    const behind = token(secret, kit, { iat: now() - 3_000, exp: now() - 290 });
    expect((await identified(kit, ahead)).response.status).toBe(200);
    expect((await identified(kit, behind)).response.status).toBe(200);
  });

  test("accepts a token that lives exactly 24 hours", async () => {
    const kit = await intakeKit();
    const secret = await generate(kit);
    const iat = now();
    const day = token(secret, kit, { iat, exp: iat + 86_400 });
    expect((await identified(kit, day)).response.status).toBe(200);
  });

  test("a report with no token is as before", async () => {
    const kit = await intakeKit();
    await generate(kit);
    const { response } = await kit.submit(goodReport({ email: "me@x.test" }));
    expect(response.status).toBe(200);
    const [report] = await reportsOf(kit);
    expect(report?.["reporterKey"]).toBeNull();
    expect(report?.["reporterName"]).toBeNull();
    expect(report?.["email"]).toBe("me@x.test");
  });

  test("a key with no secret never takes a token", async () => {
    const kit = await intakeKit();
    const { response } = await identified(kit, token("x".repeat(43), kit));
    expect(response.status).toBe(401);
    expect(await reportsOf(kit)).toHaveLength(0);
  });
});

describe("a token that is refused is a 401 and saves nothing", () => {
  const refused = async (
    make: (secret: string, kit: IntakeKit) => string | Promise<string>,
    other?: (secret: string, kit: IntakeKit) => string,
  ) => {
    const kit = await intakeKit();
    const secret = await generate(kit);
    const value = other ? other(secret, kit) : await make(secret, kit);
    const { response, body } = await identified(kit, value);
    expect(response.status).toBe(401);
    expect(codeOfBody(body)).toBe("intake.errors.identity-invalid");
    // The widget can read the refusal: the origin was accepted.
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
    expect(await reportsOf(kit)).toHaveLength(0);
  };

  test("forged: signed with another secret", () =>
    refused(
      () => "",
      (_s, kit) => token("f".repeat(43), kit),
    ));

  test("forged: payload changed after signing", () =>
    refused(
      () => "",
      (secret, kit) => {
        const [, signature] = token(secret, kit).split(".");
        return `${b64(JSON.stringify({ sub: "admin", aud: kit.key.publicKey, iat: now(), exp: now() + 60 }))}.${signature}`;
      },
    ));

  test("forged: no signature, or a truncated one", async () => {
    await refused(
      () => "",
      (secret, kit) => token(secret, kit).split(".")[0] ?? "",
    );
    await refused(
      () => "",
      (secret, kit) => token(secret, kit).slice(0, -4),
    );
  });

  test("forged: an `alg: none` token", () =>
    refused(
      () => "",
      (_s, kit) =>
        `${b64(JSON.stringify({ alg: "none", sub: "u", aud: kit.key.publicKey, iat: now(), exp: now() + 60 }))}.`,
    ));

  test("an empty header", () =>
    refused(
      () => "",
      () => "",
    ));

  test("too many segments, a bad alphabet, or too long", async () => {
    await refused(
      () => "",
      (secret, kit) => `${token(secret, kit)}.x`,
    );
    await refused(
      () => "",
      (secret, kit) => `${token(secret, kit)}!`,
    );
    await refused(
      () => "",
      (secret, kit) => `${token(secret, kit)}${"A".repeat(2_100)}`,
    );
  });

  test("garbage", () =>
    refused(
      () => "",
      () => "not a token",
    ));

  test("expired", () =>
    refused((s, kit) =>
      token(s, kit, { iat: now() - 7_200, exp: now() - 3_600 }),
    ));

  test("future-dated", () =>
    refused((s, kit) =>
      token(s, kit, { iat: now() + 3_600, exp: now() + 7_200 }),
    ));

  test("over 24 hours", () =>
    refused((s, kit) => token(s, kit, { exp: now() + 86_401 })));

  test("exp before iat", () =>
    refused((s, kit) => token(s, kit, { exp: now() - 10 })));

  test("signed for another key", () =>
    refused((s, kit) => token(s, kit, { aud: "pk_live_other" })));

  test("without a sub", () => refused((s, kit) => token(s, kit, { sub: "" })));

  test("signed with the secret of another key of the organisation", async () => {
    const kit = await intakeKit();
    const mine = await generate(kit);
    const { createWidgetKey: second } = await kit.asOwner.call<{
      createWidgetKey: { id: string; publicKey: string };
    }>(
      `mutation($input: CreateWidgetKeyInput!) { createWidgetKey(input: $input) { id publicKey } }`,
      {
        input: {
          projectId: kit.project.id,
          label: "Second",
          allowedOrigins: [kit.site],
        },
      },
    );
    const theirs = (
      await kit.asOwner.call<{
        generateWidgetIdentitySecret: { secret: string };
      }>(Generate, { keyId: second.id })
    ).generateWidgetIdentitySecret.secret;
    // Its secret under this key, and this key's token on the other key.
    const wrongSecret = await identified(kit, token(theirs, kit));
    expect(wrongSecret.response.status).toBe(401);
    const onOther = await kit.submit(
      goodReport(),
      { [IDENTITY_HEADER]: token(mine, kit) },
      second.publicKey,
    );
    expect(onOther.response.status).toBe(401);
    expect(await reportsOf(kit)).toHaveLength(0);
  });
});

describe("the rate limit per reporter", () => {
  test("the eleventh report of one reporter is a 429; another reporter is not", async () => {
    // The address limits lifted: only the reporter's counts here.
    const limits = countingLimits();
    const open = {
      consume: async () => ({ allowed: true, retryAfter: 0 }),
    };
    const own = await intakeKit({
      limits: {
        ...limits,
        intakeIpKey: open,
        intakeKey: open,
        intakeEmail: open,
      },
    });
    const secret = await generate(own);
    for (let i = 0; i < 10; i++) {
      expect((await identified(own, token(secret, own))).response.status).toBe(
        200,
      );
    }
    const over = await identified(own, token(secret, own));
    expect(over.response.status).toBe(429);
    expect(codeOfBody(over.body)).toBe("intake.errors.too-many-requests");
    const other = await identified(own, token(secret, own, { sub: "user-43" }));
    expect(other.response.status).toBe(200);
  });
});

describe("CORS", () => {
  test("the preflight allows the identity header", async () => {
    const kit = await intakeKit();
    const response = await kit.kit.app.fetch(
      new Request("https://api.pulsarix.test/public/graphql", {
        method: "OPTIONS",
        headers: { origin: kit.site },
      }),
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      IDENTITY_HEADER,
    );
  });
});
