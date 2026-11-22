import { describe, expect, test } from "bun:test";
import { memberWith } from "~/auth";
import { codeOf } from "~/http";
import { Decline } from "~/requests";
import { Counts, Inbox, One, type Page, Reply, setup } from "~/requests-team";
import { eraseReport } from "./retention.service";

describe("the organisation-wide inbox", () => {
  test("lists every project, waiting and new first, paged and filtered", async () => {
    const { w, other, ada, bob, cy } = await setup();
    const call = <T>(vars: Record<string, unknown>) =>
      w.kit.asOwner.call<T>(Inbox, vars);
    const all = await call<Page>({});
    expect(all.clientReports.nodes.map((r) => r.id)).toEqual([cy, ada, bob]);
    const first = await call<Page>({ first: 2 });
    expect(first.clientReports.nodes.map((r) => r.id)).toEqual([cy, ada]);
    expect(first.clientReports.hasNextPage).toBe(true);
    const next = await call<Page>({
      first: 2,
      after: first.clientReports.endCursor,
    });
    expect(next.clientReports.nodes.map((r) => r.id)).toEqual([bob]);
    expect(next.clientReports.hasNextPage).toBe(false);

    const only = (filter: Record<string, unknown>, projectId?: string) =>
      call<Page>({ filter, projectId }).then((page) =>
        page.clientReports.nodes.map((r) => r.id),
      );
    expect(await only({}, other.id)).toEqual([cy]);
    expect(await only({ states: ["accepted"] })).toEqual([bob]);
    expect(await only({ clientWaiting: true })).toEqual([ada]);
    expect(await only({ text: "By bob" })).toEqual([bob]);
    expect(await only({ types: ["bug"] })).toEqual([]);
    const refused = await w.kit.asOwner.attempt(Inbox, {
      projectId: "0".repeat(24),
    });
    expect(codeOf(refused)).toBe("projects.errors.not-found");
  });

  test("a member who cannot triage sees nothing; one who writes issues does", async () => {
    const { w, ada } = await setup();
    const as = async (role: "viewer" | "member") => {
      const who = await memberWith(
        w.kit.kit,
        w.kit.organisation.id,
        w.kit.owner.token,
        role,
      );
      return w.kit.kit.client(who.token, {
        organisation: w.kit.organisation.id,
      });
    };
    const viewer = await as("viewer");
    for (const [query, vars] of [
      [Inbox, {}],
      [Counts, {}],
      [One, { id: ada }],
    ] as const) {
      expect(codeOf(await viewer.attempt(query, vars))).toBe(
        "auth.errors.forbidden",
      );
    }
    expect(
      codeOf(await viewer.attempt(Reply, { id: ada, input: { body: "no" } })),
    ).toBe("auth.errors.forbidden");
    const member = await as("member");
    expect(
      (await member.call<Page>(Inbox, {})).clientReports.nodes,
    ).toHaveLength(3);
  });

  test("counts per state, whole or of one project", async () => {
    const { w, other, cy } = await setup();
    await w.kit.asOwner.call(Decline, { id: cy, reason: "No" });
    const counts = async (projectId?: string) =>
      (
        await w.kit.asOwner.call<{ clientReportCounts: object }>(Counts, {
          projectId,
        })
      ).clientReportCounts;
    expect(await counts()).toEqual({
      new: 1,
      accepted: 1,
      declined: 1,
      closed: 0,
      clientWaiting: 1,
      total: 3,
    });
    expect(await counts(other.id)).toMatchObject({ declined: 1, total: 1 });
  });

  test("an erased request is left out of the list and the counts; a plain-id cursor starts again", async () => {
    const { w, ada, bob, cy } = await setup();
    const report = await w.mongo.db.clientReports.findById(
      (await w.mongo.db.clientReports.findFirst({ title: "By bob" }))
        ?._id as never,
    );
    await eraseReport(w.mongo, report as NonNullable<typeof report>);
    const page = await w.kit.asOwner.call<Page>(Inbox, {});
    expect(page.clientReports.nodes.map((r) => r.id)).toEqual([cy, ada]);
    expect(page.clientReports.nodes.map((r) => r.id)).not.toContain(bob);
    const counts = (
      await w.kit.asOwner.call<{ clientReportCounts: { total: number } }>(
        Counts,
        {},
      )
    ).clientReportCounts;
    expect(counts.total).toBe(2);
    const old = await w.kit.asOwner.call<Page>(Inbox, { after: ada });
    expect(old.clientReports.nodes.map((r) => r.id)).toEqual([cy, ada]);
  });
});
