import { describe, expect, test } from "bun:test";
import { asPreV2Key, codeOfBody, goodReport, intakeKit } from "~/intake";
import { subscribe } from "~/sse";
import { reportsOf } from "~/submit";

describe("a key reads nothing but its own config", () => {
  test("the config names its project, in the language asked", async () => {
    const kit = await intakeKit();
    const { response, body } = await kit.config({ "accept-language": "fr" });
    expect(response.status).toBe(200);
    expect(body?.data).toEqual({
      widgetConfig: {
        projectName: "Alpha",
        locale: "fr",
        enabled: true,
        attachments: true,
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("a key stored before v2 (no file fields) still has attachments on", async () => {
    const kit = await intakeKit();
    await asPreV2Key(kit);
    const { body } = await kit.config();
    expect(body?.data).toMatchObject({ widgetConfig: { attachments: true } });
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
      widgetConfig: {
        projectName: null,
        locale: "en",
        enabled: false,
        attachments: false,
      },
    });
    const refused = await kit.submit();
    expect(codeOfBody(refused.body)).toBe("intake.errors.key-disabled");
    expect(await reportsOf(kit)).toHaveLength(0);
  });
});

const Reports = `subscription($projectId: ID!) {
  clientReportReceived(projectId: $projectId) { reportId title at }
}`;

describe("a report reaches the team's inbox live", () => {
  test("a submitted report is delivered on clientReportReceived to that project's readers only", async () => {
    // The intake as the server builds it, so the publish under test is the
    // server's own, not the kit's recorder.
    const kit = await intakeKit({ server: true });
    const other = await kit.asOwner.call<{ createProject: { id: string } }>(
      `mutation($input: CreateProjectInput!) { createProject(input: $input) { id } }`,
      { input: { key: "OTH", name: "Other" } },
    );
    const open = (projectId: string) =>
      subscribe<{
        clientReportReceived: { reportId: string; title: string; at: string };
      }>(
        kit.kit,
        kit.owner.token,
        { organisation: kit.organisation.id },
        Reports,
        { projectId },
      );
    const inbox = await open(kit.project.id);
    const elsewhere = await open(other.createProject.id);
    expect(inbox.status).toBe(200);
    // Let both readers register before the report arrives.
    await Bun.sleep(100);

    const { body } = await kit.submit();
    const data = body?.data as unknown as {
      submitClientReport: { reportId: string };
    };
    const reportId = data.submitClientReport.reportId;
    await kit.intake.settled();

    const event = (await inbox.next())?.data?.clientReportReceived;
    expect(event).toMatchObject({
      reportId,
      title: "The save button does nothing",
    });
    expect(Number.isNaN(Date.parse(event?.at ?? ""))).toBe(false);
    expect(await elsewhere.quiet()).toBe(true);

    // A refused report is delivered to no one.
    await kit.submit({ ...goodReport(), filledInMs: 10 });
    await kit.intake.settled();
    expect(await inbox.quiet()).toBe(true);
    await inbox.close();
    await elsewhere.close();
  });
});
