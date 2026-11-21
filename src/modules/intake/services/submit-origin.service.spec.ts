import { describe, expect, test } from "bun:test";
import {
  codeOfBody,
  type countingLimits,
  goodReport,
  intakeKit,
} from "~/intake";
import { reportsOf } from "~/submit";

describe("a foreign origin is refused", () => {
  test("config and submit answer 403 with no CORS header, and store nothing", async () => {
    const kit = await intakeKit();
    for (const origin of [
      "https://evil.test",
      "https://app.client.test.evil.test",
      "http://app.client.test",
      null,
    ]) {
      const config = await kit.config({ origin });
      expect(config.response.status).toBe(403);
      expect(codeOfBody(config.body)).toBe("intake.errors.origin-not-allowed");
      expect(
        config.response.headers.get("access-control-allow-origin"),
      ).toBeNull();
      const submitted = await kit.submit(goodReport(), { origin });
      expect(submitted.response.status).toBe(403);
      expect(
        submitted.response.headers.get("access-control-allow-origin"),
      ).toBeNull();
    }
    expect(await reportsOf(kit)).toHaveLength(0);
  });

  test("a foreign site cannot burn a key's quota", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 20; i++) {
      await kit.submit(goodReport(), { origin: "https://evil.test" });
    }
    const counts = (kit.limits as ReturnType<typeof countingLimits>).intakeKey
      .counts;
    expect(counts.get(kit.key.publicKey) ?? 0).toBe(0);
  });

  test("the preflight answers CORS for an origin some key allows, and for no other", async () => {
    const kit = await intakeKit();
    const preflight = (origin: string | null) =>
      kit.kit.app.fetch(
        new Request("https://api.pulsarix.test/public/graphql", {
          method: "OPTIONS",
          headers: {
            ...(origin && { origin }),
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
      );
    const allowed = await preflight(kit.site);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(kit.site);
    expect(allowed.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
    for (const origin of ["https://evil.test", "not an origin", null]) {
      const refused = await preflight(origin);
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    }
    // A switched-off key still passes the preflight, so the widget reads `enabled: false`.
    await kit.asOwner.call(
      `mutation($id: ID!, $input: UpdateWidgetKeyInput!) { updateWidgetKey(id: $id, input: $input) { id } }`,
      { id: kit.key.id, input: { active: false } },
    );
    expect((await preflight(kit.site)).status).toBe(204);
    // A revoked key allows nothing any more.
    await kit.asOwner.call(`mutation($id: ID!) { revokeWidgetKey(id: $id) }`, {
      id: kit.key.id,
    });
    expect((await preflight(kit.site)).status).toBe(403);
  });

  test("the origin of a key is edited, not widened by a wildcard or a path", async () => {
    const kit = await intakeKit();
    for (const bad of [
      "*",
      "https://*.client.test",
      "https://app.client.test/path",
      "http://app.client.test",
      "ftp://x.test",
      "https://u:p@app.client.test",
      "app.client.test",
    ]) {
      const result = await kit.asOwner.attempt(
        `mutation($id: ID!, $input: UpdateWidgetKeyInput!) { updateWidgetKey(id: $id, input: $input) { id } }`,
        { id: kit.key.id, input: { allowedOrigins: [bad] } },
      );
      expect(result.errors?.[0]?.extensions?.code).toBe(
        "intake.errors.invalid-origin",
      );
    }
    const ok = await kit.asOwner.call<{
      updateWidgetKey: { allowedOrigins: string[] };
    }>(
      `mutation($id: ID!, $input: UpdateWidgetKeyInput!) { updateWidgetKey(id: $id, input: $input) { allowedOrigins } }`,
      {
        id: kit.key.id,
        input: {
          allowedOrigins: [
            "HTTPS://App.Client.test:443",
            "http://localhost:3000",
            "https://app.client.test",
          ],
        },
      },
    );
    expect(ok.updateWidgetKey.allowedOrigins).toEqual([
      "https://app.client.test",
      "http://localhost:3000",
    ]);
  });
});
