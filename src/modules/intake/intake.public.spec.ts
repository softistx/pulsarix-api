import { describe, expect, test } from "bun:test";
import { uiOrigin } from "~/auth";
import {
  codeOfBody,
  countingLimits,
  goodReport,
  type IntakeKit,
  intakeKit,
} from "~/intake";
import { coreMongo, tenancy } from "../../config/db";
import { addressKey } from "./intake.routes";
import type { Caller } from "./intake.submit";

const trackingToken = (kit: IntakeKit) => {
  const mail = kit.mailer.sent.at(-1);
  const found = mail?.text.match(/\/track\/(\S+)/);
  if (!found?.[1]) throw new Error("no tracking link was mailed");
  return found[1];
};

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

describe("a key reads nothing but its own config", () => {
  test("the config names its project, in the language asked", async () => {
    const kit = await intakeKit();
    const { response, body } = await kit.config({ "accept-language": "fr" });
    expect(response.status).toBe(200);
    expect(body?.data).toEqual({
      widgetConfig: { projectName: "Alpha", locale: "fr", enabled: true },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("another project's key names that project, never this one", async () => {
    const kit = await intakeKit();
    const other = await kit.asOwner.call<{ createProject: { id: string } }>(
      `mutation($input: CreateProjectInput!) { createProject(input: $input) { id } }`,
      { input: { key: "OTH", name: "Other" } },
    );
    const second = await kit.asOwner.call<{
      createWidgetKey: { publicKey: string };
    }>(
      `mutation($input: CreateWidgetKeyInput!) { createWidgetKey(input: $input) { publicKey } }`,
      {
        input: {
          projectId: other.createProject.id,
          label: "Other site",
          allowedOrigins: [kit.site],
        },
      },
    );
    const { body } = await kit.config({}, second.createWidgetKey.publicKey);
    expect(body?.data).toMatchObject({
      widgetConfig: { projectName: "Other" },
    });
  });

  test("only the three persisted operations run: no query, no introspection, no extra field", async () => {
    const kit = await intakeKit();
    for (const body of [
      { query: "{ __schema { types { name } } }" },
      {
        id: "widgetConfig",
        query: "{ __typename }",
        variables: { publicKey: kit.key.publicKey },
      },
      { id: "viewer" },
      { id: "__proto__" },
      { id: "widgetConfig", variables: [] },
      [{ id: "widgetConfig" }],
      "not json",
    ]) {
      const response = await kit.post(body);
      expect(response.status).toBe(400);
      expect(codeOfBody(await response.json())).toBe(
        "intake.errors.persisted-only",
      );
    }
  });

  test("a body that is not JSON content-type is refused, so no form reaches it", async () => {
    const kit = await intakeKit();
    const response = await kit.post(
      { id: "widgetConfig", variables: { publicKey: kit.key.publicKey } },
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(response.status).toBe(415);
  });

  test("an unknown, a malformed and a revoked key answer alike: 404", async () => {
    const kit = await intakeKit();
    for (const publicKey of [
      `pk_live_${"a".repeat(32)}`,
      "nope",
      "x".repeat(3000),
    ]) {
      const { response, body } = await kit.config({}, publicKey);
      expect(response.status).toBe(404);
      expect(codeOfBody(body)).toBe("intake.errors.unknown-key");
    }
    await kit.asOwner.call(`mutation($id: ID!) { revokeWidgetKey(id: $id) }`, {
      id: kit.key.id,
    });
    const { response, body } = await kit.config();
    expect(response.status).toBe(404);
    expect(codeOfBody(body)).toBe("intake.errors.unknown-key");
  });

  test("a disabled key says so and names nothing", async () => {
    const kit = await intakeKit();
    await kit.asOwner.call(
      `mutation($id: ID!, $input: UpdateWidgetKeyInput!) { updateWidgetKey(id: $id, input: $input) { id } }`,
      { id: kit.key.id, input: { active: false } },
    );
    const { body } = await kit.config();
    expect(body?.data).toEqual({
      widgetConfig: { projectName: null, locale: "en", enabled: false },
    });
    const refused = await kit.submit();
    expect(codeOfBody(refused.body)).toBe("intake.errors.key-disabled");
    expect(await reportsOf(kit)).toHaveLength(0);
  });
});

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

describe("submitting a report", () => {
  test("it is stored with what the sender gave and what the server saw", async () => {
    const kit = await intakeKit();
    const { response, body } = await kit.submit(
      goodReport({
        email: " Reporter@Client.test ",
        pageUrl: "https://app.client.test/settings?tab=1#frag",
        locale: "fr",
        metadata: [{ key: "plan", value: "pro" }],
      }),
      { "user-agent": "Spec/1.0" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
    const data = body?.data as unknown as {
      submitClientReport: { reportId: string; tracking: boolean };
    };
    const result = data.submitClientReport;
    expect(result.tracking).toBe(true);
    const [stored] = await reportsOf(kit);
    expect(stored).toMatchObject({
      title: "The save button does nothing",
      state: "new",
      email: "Reporter@Client.test",
      pageUrl: "https://app.client.test/settings?tab=1",
      userAgent: "Spec/1.0",
      locale: "fr",
      metadata: [{ key: "plan", value: "pro" }],
      issueId: null,
    });
    expect(String(stored?.["_id"])).toBe(result.reportId);
    await kit.intake.settled();
    expect(kit.published).toEqual([
      expect.objectContaining({
        organisationId: kit.organisation.id,
        projectId: kit.project.id,
        reportId: result.reportId,
        title: "The save button does nothing",
      }),
    ]);
  });

  test("with an e-mail the reporter gets the tracking link, and only its hash is kept", async () => {
    const kit = await intakeKit();
    await kit.submit(
      goodReport({ email: "reporter@client.test", locale: "fr" }),
    );
    await kit.intake.settled();
    expect(kit.mailer.sent).toHaveLength(1);
    const mail = kit.mailer.sent[0];
    expect(mail?.subject).toContain("Alpha");
    expect(mail?.text).toContain(`${uiOrigin}/track/${kit.organisation.id}.`);
    // Nothing the sender typed is repeated in a mail to an address that may not be theirs.
    expect(mail?.text).not.toContain("save button");
    expect(mail?.html).not.toContain("save button");
    const token = trackingToken(kit);
    const [stored] = await reportsOf(kit);
    expect(token.split(".")[1]).toHaveLength(43);
    expect(JSON.stringify(stored)).not.toContain(token.split(".")[1] as string);
    expect(String(stored?.["trackingTokenHash"])).toMatch(/^[0-9a-f]{64}$/);
  });

  test("without an e-mail there is no token and no mail", async () => {
    const kit = await intakeKit();
    const { body } = await kit.submit();
    expect(body?.data).toMatchObject({
      submitClientReport: { tracking: false },
    });
    await kit.intake.settled();
    expect(kit.mailer.sent).toHaveLength(0);
    const [stored] = await reportsOf(kit);
    expect(stored?.["trackingTokenHash"]).toBeNull();
    expect(stored?.["email"]).toBeNull();
  });

  test("text is cleaned and bounded: control characters go, markup stays inert text", async () => {
    const kit = await intakeKit();
    await kit.submit(goodReport({ title: "  <b>Hi</b>\u0000\u0007 there  " }));
    const [stored] = await reportsOf(kit);
    expect(stored?.["title"]).toBe("<b>Hi</b> there");
  });

  test("invalid input is refused with its fields, and nothing is stored", async () => {
    const kit = await intakeKit();
    const cases: [Record<string, unknown>, string][] = [
      [goodReport({ title: "   " }), "title"],
      [goodReport({ title: "x".repeat(201) }), "title"],
      [goodReport({ description: "" }), "description"],
      [goodReport({ description: "x".repeat(10_001) }), "description"],
      [goodReport({ email: "not an email" }), "email"],
      [goodReport({ locale: "de" }), "locale"],
      [
        goodReport({
          metadata: Array.from({ length: 21 }, (_, i) => ({
            key: `k${i}`,
            value: "v",
          })),
        }),
        "metadata",
      ],
      [
        goodReport({ metadata: [{ key: "k", value: "x".repeat(600) }] }),
        "metadata.0.value",
      ],
    ];
    for (const [input, path] of cases) {
      // Every attempt counts against the address's five; this spec is about the input.
      (
        kit.limits as ReturnType<typeof countingLimits>
      ).intakeIpKey.counts.clear();
      const { response, body } = await kit.submit(input);
      expect(response.status).toBe(400);
      expect(codeOfBody(body)).toBe("validation.errors.invalid-input");
      const fields = body?.errors?.[0]?.extensions?.["fields"] as {
        path: string;
      }[];
      expect(fields.map((f) => f.path)).toContain(path);
    }
    // Metadata that is small per entry but over 2 KB in all.
    const big = await kit.submit(
      goodReport({
        metadata: Array.from({ length: 10 }, (_, i) => ({
          key: `key${i}`,
          value: "v".repeat(300),
        })),
      }),
    );
    expect(big.response.status).toBe(400);
    expect(await reportsOf(kit)).toHaveLength(0);
  });

  test("a body past the limit is refused before it is read", async () => {
    const kit = await intakeKit();
    const { response } = await kit.submit(
      goodReport({ description: "x".repeat(70_000) }),
    );
    expect([400, 413]).toContain(response.status);
    expect(await reportsOf(kit)).toHaveLength(0);
  });

  test("the honeypot is told it worked and nothing is kept", async () => {
    const kit = await intakeKit();
    const { response, body } = await kit.submit(
      goodReport({ website: "http://spam.test", email: "bot@spam.test" }),
    );
    expect(response.status).toBe(200);
    expect(body?.data).toMatchObject({
      submitClientReport: { tracking: true },
    });
    await kit.intake.settled();
    expect(await reportsOf(kit)).toHaveLength(0);
    expect(kit.mailer.sent).toHaveLength(0);
    expect(kit.published).toHaveLength(0);
  });

  test("a form sent faster than a person fills it is refused", async () => {
    const kit = await intakeKit();
    const { response, body } = await kit.submit(
      goodReport({ filledInMs: 400 }),
    );
    expect(response.status).toBe(400);
    expect(codeOfBody(body)).toBe("intake.errors.too-fast");
    expect(await reportsOf(kit)).toHaveLength(0);
  });

  test("it stores into its own organisation's database only", async () => {
    const kit = await intakeKit();
    const other = await intakeKit();
    await kit.submit();
    expect(await reportsOf(kit)).toHaveLength(1);
    expect(await reportsOf(other)).toHaveLength(0);
  });

  test("a key stamps lastUsedAt, to the minute", async () => {
    const kit = await intakeKit();
    await kit.config();
    await kit.intake.settled();
    const stored = await coreMongo.db.widgetKeys.findFirst({
      publicKey: kit.key.publicKey,
    });
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("over the limits the answer is 429", () => {
  const direct = (
    kit: IntakeKit,
    ip = "203.0.113.7",
    origin = kit.site,
  ): Caller => ({
    ip,
    origin,
    userAgent: null,
    language: "en",
    originGranted: false,
  });

  test("the sixth report of one address through one key", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 5; i++) {
      expect((await kit.submit()).response.status).toBe(200);
    }
    const { response, body } = await kit.submit();
    expect(response.status).toBe(429);
    expect(codeOfBody(body)).toBe("intake.errors.too-many-requests");
    expect(response.headers.get("retry-after")).toBe("90");
    expect(body?.errors?.[0]?.extensions).toMatchObject({
      retryAfter: 90,
      minutes: 2,
    });
    // The widget can read the refusal: the origin was accepted.
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
    expect(await reportsOf(kit)).toHaveLength(5);
  });

  test("another address has its own five", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 6; i++) {
      await kit.intake
        .submit(kit.key.publicKey, goodReport(), direct(kit, "198.51.100.1"))
        .catch(() => {});
    }
    await expect(
      kit.intake.submit(
        kit.key.publicKey,
        goodReport(),
        direct(kit, "198.51.100.1"),
      ),
    ).rejects.toMatchObject({
      extensions: { code: "intake.errors.too-many-requests" },
    });
    await expect(
      kit.intake.submit(
        kit.key.publicKey,
        goodReport(),
        direct(kit, "198.51.100.2"),
      ),
    ).resolves.toMatchObject({ tracking: false });
  });

  test("the key's hourly limit holds across addresses", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 60; i++) {
      await kit.intake.submit(
        kit.key.publicKey,
        goodReport(),
        direct(kit, `10.0.${Math.floor(i / 5)}.${i % 5}`),
      );
    }
    await expect(
      kit.intake.submit(
        kit.key.publicKey,
        goodReport(),
        direct(kit, "10.9.9.9"),
      ),
    ).rejects.toMatchObject({
      extensions: { code: "intake.errors.too-many-requests" },
    });
  });

  test("the fourth report naming one e-mail", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 3; i++) {
      await kit.intake.submit(
        kit.key.publicKey,
        goodReport({ email: "Same@x.test" }),
        direct(kit, `10.1.0.${i}`),
      );
    }
    await expect(
      kit.intake.submit(
        kit.key.publicKey,
        goodReport({ email: "same@X.test" }),
        direct(kit, "10.1.0.9"),
      ),
    ).rejects.toMatchObject({
      extensions: { code: "intake.errors.too-many-requests" },
    });
    // No address is written to the limiter's keys.
    const keys = [
      ...(
        kit.limits as ReturnType<typeof countingLimits>
      ).intakeEmail.counts.keys(),
    ];
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  test("the organisation's ceiling holds across its keys", async () => {
    const kit = await intakeKit();
    const limits = kit.limits as ReturnType<typeof countingLimits>;
    limits.intakeOrganisation.counts.set(kit.organisation.id, 300);
    const { response, body } = await kit.submit();
    expect(response.status).toBe(429);
    expect(codeOfBody(body)).toBe("intake.errors.too-many-requests");
  });

  test("reads and preflights of one address are limited too", async () => {
    const kit = await intakeKit();
    const limits = kit.limits as ReturnType<typeof countingLimits>;
    limits.intakeReadIp.counts.set("unknown", 120);
    expect((await kit.config()).response.status).toBe(429);
  });

  test("the tracking page's reads are limited", async () => {
    const kit = await intakeKit();
    const limits = kit.limits as ReturnType<typeof countingLimits>;
    limits.intakeTrackingIp.counts.set("unknown", 30);
    const { response, body } = await kit.track(
      `${kit.organisation.id}.${"a".repeat(43)}`,
    );
    expect(response.status).toBe(429);
    expect(codeOfBody(body)).toBe("intake.errors.too-many-requests");
  });

  test("with no way to count, the endpoint refuses (503) instead of opening unmetered", async () => {
    const kit = await intakeKit({ limits: undefined });
    const { response, body } = await kit.config();
    expect(response.status).toBe(503);
    expect(codeOfBody(body)).toBe("intake.errors.unavailable");
    expect((await kit.submit()).response.status).toBe(503);
    expect(await reportsOf(kit)).toHaveLength(0);
  });

  test("a limiter that fails is a 503, never a pass", async () => {
    const limits = countingLimits();
    const kit = await intakeKit({
      limits: {
        ...limits,
        intakeReadIp: {
          consume: async () => {
            throw new Error("redis down");
          },
        },
      },
    });
    expect((await kit.config()).response.status).toBe(503);
  });
});

test("IPv6 clients are limited by their /64", () => {
  expect(addressKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  expect(addressKey("2001:DB8::1")).toBe("2001:db8:0:0::/64");
  expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
  expect(addressKey(undefined)).toBe("unknown");
});
