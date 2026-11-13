import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { goodReport, intakeKit } from "~/intake";
import { tenancy } from "../../config/db";
import type { ClientReportDocument } from "./intake.model";
import { eraseAll, eraseSettled, RETENTION_DAYS } from "./intake.retention";

const DAY = 86_400_000;

type Mongo = Parameters<typeof eraseSettled>[0];

async function setup() {
  const kit = await intakeKit();
  const mongo = (await tenancy.databaseOf(
    kit.organisation.id,
  )) as unknown as Mongo;
  const make = async (
    patch: Partial<ClientReportDocument>,
    email = "r@client.test",
  ) => {
    const { body } = await kit.submit(goodReport({ email }));
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
    const data = body?.data as unknown as {
      submitClientReport: { reportId: string };
    };
    const id = data.submitClientReport.reportId;
    await mongo.db.clientReports.update(new ObjectId(id), patch as never);
    return new ObjectId(id);
  };
  return { kit, mongo, make };
}

describe("the retention job (Q15)", () => {
  test("a declined report loses its e-mail, user agent, page URL, metadata and token 90 days after the decision", async () => {
    const { mongo, make } = await setup();
    const now = new Date();
    const due = await make({
      state: "declined",
      decidedAt: new Date(now.getTime() - RETENTION_DAYS * DAY),
      pageUrl: "https://app.client.test/settings",
      metadata: [{ key: "plan", value: "pro" }],
    });
    const early = await make({
      state: "declined",
      decidedAt: new Date(now.getTime() - (RETENTION_DAYS - 1) * DAY),
    });
    expect(await eraseSettled(mongo, now)).toBe(1);
    const erased = await mongo.db.clientReports.findById(due);
    expect(erased).toMatchObject({
      email: null,
      userAgent: null,
      pageUrl: null,
      metadata: [],
      trackingTokenHash: null,
    });
    expect(erased?.erasedAt).toBeInstanceOf(Date);
    // The text stays: it is the team's record of what was asked.
    expect(erased?.title).toBe("The save button does nothing");
    const kept = await mongo.db.clientReports.findById(early);
    expect(kept?.email).toBe("r@client.test");
    expect(kept?.erasedAt).toBeNull();
  });

  test("a closed report counts from its closing; a new or accepted one is never erased", async () => {
    const { mongo, make } = await setup();
    const now = new Date();
    const old = new Date(now.getTime() - 200 * DAY);
    const closed = await make({
      state: "closed",
      closedAt: old,
    });
    const open = await make({ state: "new" });
    const accepted = await make({ state: "accepted", decidedAt: old });
    expect(await eraseSettled(mongo, now)).toBe(1);
    expect((await mongo.db.clientReports.findById(closed))?.email).toBeNull();
    expect((await mongo.db.clientReports.findById(open))?.email).toBe(
      "r@client.test",
    );
    expect((await mongo.db.clientReports.findById(accepted))?.email).toBe(
      "r@client.test",
    );
  });

  test("it is safe to repeat, and an erased tracking link stops working", async () => {
    const { kit, mongo, make } = await setup();
    const now = new Date();
    await make({
      state: "declined",
      decidedAt: new Date(now.getTime() - 100 * DAY),
    });
    await kit.intake.settled();
    const token = kit.mailer.sent
      .at(-1)
      ?.text.match(/\/track\/(\S+)/)?.[1] as string;
    expect((await kit.track(token)).response.status).toBe(200);
    expect(await eraseSettled(mongo, now)).toBe(1);
    expect(await eraseSettled(mongo, now)).toBe(0);
    expect((await kit.track(token)).response.status).toBe(404);
  });

  test("it runs over every organisation, and one that fails does not stop the others", async () => {
    const { kit, make } = await setup();
    const now = new Date();
    const id = await make({
      state: "declined",
      decidedAt: new Date(now.getTime() - 120 * DAY),
    });
    const logged: string[] = [];
    const erased = await eraseAll(
      tenancy,
      new Date(now.getTime() + DAY),
      (m) => {
        logged.push(m);
      },
    );
    expect(erased).toBeGreaterThanOrEqual(1);
    const mongo = (await tenancy.databaseOf(
      kit.organisation.id,
    )) as unknown as Mongo;
    expect((await mongo.db.clientReports.findById(id))?.email).toBeNull();
    const broken = {
      eachTenant: async () => [
        { tenant: {}, ok: false as const, error: new Error("unreachable") },
        { tenant: {}, ok: true as const, value: 2 },
      ],
    };
    await expect(
      eraseAll(broken as never, now, (m) => {
        logged.push(m);
      }),
    ).rejects.toThrow("failed for 1 organisation");
    expect(logged.at(-1)).toContain("retention failed");
  });
});
