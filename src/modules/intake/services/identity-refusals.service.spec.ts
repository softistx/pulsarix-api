import { describe, expect, test } from "bun:test";
import {
  b64,
  Generate,
  generate,
  identified,
  now,
  reportsOf,
  token,
} from "~/identity";
import { codeOfBody, goodReport, type IntakeKit, intakeKit } from "~/intake";
import { IDENTITY_HEADER } from "./identity.service";

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
