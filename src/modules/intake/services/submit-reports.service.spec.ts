import { describe, expect, test } from "bun:test";
import { uiOrigin } from "~/auth";
import {
  codeOfBody,
  type countingLimits,
  goodReport,
  intakeKit,
} from "~/intake";
import { reportsOf, trackingToken } from "~/submit";
import { coreMongo } from "../../../config/db";

describe("submitting a report", () => {
  test("it is stored (page URL without its query or fragment) with what the sender gave and what the server saw", async () => {
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
      pageUrl: "https://app.client.test/settings",
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
