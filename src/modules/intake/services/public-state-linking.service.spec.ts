import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { codeOf } from "~/http";
import { intakeKit } from "~/intake";
import {
  AddComment,
  accept,
  IssueOf,
  type IssueOut,
  Link,
  move,
  named,
  type ReportOut,
  reportOf,
  reports,
  send,
  statusesOf,
  tracked,
  withTracking,
} from "~/public-state";
import { tenancy } from "../../../config/db";
import { SYSTEM_ACTOR } from "../../../core/shared/actors";
import { ReportsService } from "./reports.service";
import type { IntakeMongo } from "./submit.service";

describe("linkClientReport", () => {
  test("several reports share one issue, and follow it", async () => {
    const kit = await intakeKit();
    const first = await withTracking(kit);
    const { acceptClientReport } = await accept(kit, first.id);
    const issueId = acceptClientReport.issueId as string;
    const dup = await withTracking(kit, { impact: "blocking" });
    const { linkClientReport } = await kit.asOwner.call<{
      linkClientReport: ReportOut & { linkedAt: string };
    }>(Link, { id: dup.id, issueId });
    expect(linkClientReport).toMatchObject({
      state: "accepted",
      issueId,
      publicState: "received",
    });
    expect(linkClientReport.linkedAt).toBeString();
    // Linking made no issue and did not touch the existing one's priority.
    const all = await kit.asOwner.call<{ issues: { nodes: IssueOut[] } }>(
      IssueOf,
      { id: kit.project.id },
    );
    expect(all.issues.nodes).toHaveLength(1);
    expect(all.issues.nodes[0]?.priority).toBe("none");

    const { statuses } = await statusesOf(kit);
    await move(kit, issueId, named(statuses, "In progress").id);
    expect((await tracked(kit, dup.token))["publicState"]).toBe("inProgress");
    expect((await tracked(kit, first.token))["publicState"]).toBe("inProgress");

    // Done closes both reports; moving back reopens both.
    await move(kit, issueId, named(statuses, "Done").id);
    expect((await reports(kit)).map((r) => r.state)).toEqual([
      "closed",
      "closed",
    ]);
    expect((await tracked(kit, dup.token))["publicState"]).toBe("resolved");
    await move(kit, issueId, named(statuses, "Todo").id);
    expect((await reports(kit)).map((r) => r.state)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  test("the tracking page of a linked report hides the replies written before the link", async () => {
    const kit = await intakeKit();
    const first = await send(kit);
    const issueId = (await accept(kit, first)).acceptClientReport
      .issueId as string;
    await kit.asOwner.call(AddComment, {
      issueId,
      input: { body: "Said to the first reporter", public: true },
    });
    await Bun.sleep(20);
    const dup = await withTracking(kit);
    await kit.asOwner.call(Link, { id: dup.id, issueId });
    await Bun.sleep(20);
    await kit.asOwner.call(AddComment, {
      issueId,
      input: { body: "Said after the link", public: true },
    });
    const { replies } = (await tracked(kit, dup.token)) as unknown as {
      replies: { body: string }[];
    };
    expect(replies.map((r) => r.body)).toEqual(["Said after the link"]);
  });

  test("a report linked to a settled issue is closed at once", async () => {
    const kit = await intakeKit();
    const first = await send(kit);
    const issueId = (await accept(kit, first)).acceptClientReport
      .issueId as string;
    const { statuses } = await statusesOf(kit);
    await move(kit, issueId, named(statuses, "Done").id);
    const dup = await send(kit);
    const { linkClientReport } = await kit.asOwner.call<{
      linkClientReport: ReportOut;
    }>(Link, { id: dup, issueId });
    expect(linkClientReport.publicState).toBe("resolved");
    expect((await reportOf(kit, dup)).state).toBe("closed");
  });

  test("link() reads the issue again after the claim: one that settles meanwhile closes the report", async () => {
    const kit = await intakeKit();
    const first = await send(kit);
    const issueId = (await accept(kit, first)).acceptClientReport
      .issueId as string;
    const { statuses } = await statusesOf(kit);
    const done = named(statuses, "Done").id;
    const dup = await send(kit);
    const real = (await tenancy.databaseOf(kit.organisation.id)).as(
      SYSTEM_ACTOR,
    ) as unknown as IntakeMongo;
    // The issue is settled right after the claim commits, by a write the
    // claim could not see (no change hook runs for it): only a re-read finds it.
    const reports = real.db.clientReports;
    const claimed = new Proxy(reports, {
      get(target, property) {
        if (property !== "update") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...given: Parameters<typeof reports.update>) => {
          const result = await reports.update(...given);
          if ((given[1] as { state?: string }).state === "accepted") {
            await real.db.issues.raw.updateOne(
              { _id: new ObjectId(issueId) },
              { $set: { statusId: new ObjectId(done) } },
            );
          }
          return result;
        };
      },
    });
    const mongo = new Proxy(real, {
      get(target, property) {
        if (property === "db") {
          return new Proxy(target.db, {
            get: (db, name) =>
              name === "clientReports" ? claimed : Reflect.get(db, name, db),
          });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new ReportsService(mongo, null as never, SYSTEM_ACTOR);
    const linked = await service.link(dup, issueId);
    expect(linked.state).toBe("closed");
  });

  test("only a new report links, to an issue of its own project", async () => {
    const kit = await intakeKit();
    const first = await send(kit);
    const issueId = (await accept(kit, first)).acceptClientReport
      .issueId as string;
    const decided = await kit.asOwner.attempt(Link, { id: first, issueId });
    expect(codeOf(decided)).toBe("intake.errors.report-decided");
    const fresh = await send(kit);
    expect(
      codeOf(
        await kit.asOwner.attempt(Link, {
          id: fresh,
          issueId: new ObjectId().toHexString(),
        }),
      ),
    ).toBe("issues.errors.not-found");
    expect((await reportOf(kit, fresh)).state).toBe("new");
  });
});
