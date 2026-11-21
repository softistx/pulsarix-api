import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import {
  Generate,
  generate,
  identified,
  now,
  reportsOf,
  token,
} from "~/identity";
import { codeOfBody, goodReport, intakeKit } from "~/intake";
import { coreMongo } from "../../../config/db";
import { reporterKeyOf } from "./identity.service";

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
