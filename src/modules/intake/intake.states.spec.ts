import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { codeOf } from "~/http";
import { goodReport, type IntakeKit, intakeKit } from "~/intake";
import { tenancy } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import { derivePublicState } from "./intake.publicstate";
import { ReportsService } from "./intake.reports";
import type { IntakeMongo } from "./intake.submit";

// A15: public states, links, impact and type (plan §19).
const Statuses = `query($key: String!) {
  project(key: $key) { statuses { id name category publicState } labels { id name } }
}`;
const CreateStatus = `mutation($input: CreateStatusInput!) {
  createStatus(input: $input) { id name category publicState }
}`;
const UpdateStatus = `mutation($id: ID!, $input: UpdateStatusInput!) {
  updateStatus(id: $id, input: $input) { id category publicState }
}`;
const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id state issueId publicState } }`;
const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id state declineReasonPublic publicState }
}`;
const Link = `mutation($id: ID!, $issueId: ID!) {
  linkClientReport(id: $id, issueId: $issueId) { id state issueId linkedAt publicState }
}`;
const Report = `query($projectId: ID!) {
  clientReports(projectId: $projectId) {
    nodes { id state impact type publicState declineReasonPublic declineReason issueId }
  }
}`;
const IssueOf = `query($id: ID!) {
  issues(projectId: $id) { nodes { id key statusId priority priorityOrigin labelIds } }
}`;
const Move = `mutation($id: ID!, $statusId: ID!) { moveIssue(id: $id, statusId: $statusId) { id } }`;
const Update = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { id priority priorityOrigin }
}`;

interface StatusOut {
  id: string;
  name: string;
  category: string;
  publicState: string;
}
interface ReportOut {
  id: string;
  state: string;
  issueId: string | null;
  impact: string | null;
  type: string | null;
  publicState: string;
  declineReasonPublic: boolean;
  declineReason: string | null;
}
interface IssueOut {
  id: string;
  key: string;
  statusId: string;
  priority: string;
  priorityOrigin: string;
  labelIds: string[];
}

const statusesOf = async (kit: IntakeKit) =>
  (
    await kit.asOwner.call<{
      project: {
        statuses: StatusOut[];
        labels: { id: string; name: string }[];
      };
    }>(Statuses, { key: "ABC" })
  ).project;
const named = (statuses: StatusOut[], name: string) =>
  statuses.find((status) => status.name === name) as StatusOut;

async function send(kit: IntakeKit, extra: Record<string, unknown> = {}) {
  (
    kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
  ).intakeIpKey.counts.clear();
  const { body } = await kit.submit(goodReport(extra));
  const data = body?.data as unknown as {
    submitClientReport: { reportId: string };
  };
  return data.submitClientReport.reportId;
}
const reports = async (kit: IntakeKit) =>
  (
    await kit.asOwner.call<{ clientReports: { nodes: ReportOut[] } }>(Report, {
      projectId: kit.project.id,
    })
  ).clientReports.nodes;
const reportOf = async (kit: IntakeKit, id: string) =>
  (await reports(kit)).find((report) => report.id === id) as ReportOut;
const accept = (kit: IntakeKit, id: string) =>
  kit.asOwner.call<{ acceptClientReport: ReportOut }>(Accept, { id });
const issueOf = async (kit: IntakeKit, id: string) =>
  (
    await kit.asOwner.call<{ issues: { nodes: IssueOut[] } }>(IssueOf, {
      id: kit.project.id,
    })
  ).issues.nodes.find((issue) => issue.id === id) as IssueOut;
const move = (kit: IntakeKit, id: string, statusId: string) =>
  kit.asOwner.call(Move, { id, statusId });
const tracked = async (kit: IntakeKit, token: string) =>
  (await kit.track(token)).body?.data?.["clientReportStatus"] as Record<
    string,
    unknown
  >;
// A report with an e-mail, so its tracking page can be read.
async function withTracking(kit: IntakeKit, extra = {}) {
  const id = await send(kit, { email: "r@client.test", ...extra });
  await kit.intake.settled();
  const token = kit.mailer.sent.at(-1)?.text.match(/\/track\/(\S+)/)?.[1];
  return { id, token: token as string };
}

describe("Status.publicState", () => {
  test("defaults by category for the default workflow", async () => {
    const kit = await intakeKit();
    const { statuses } = await statusesOf(kit);
    expect(
      Object.fromEntries(statuses.map((s) => [s.category, s.publicState])),
    ).toEqual({
      triage: "received",
      backlog: "received",
      todo: "received",
      inProgress: "inProgress",
      done: "resolved",
      cancelled: "declined",
    });
  });

  test("a status stored before the field reads its category's default", async () => {
    const kit = await intakeKit();
    const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
      db: { statuses: { raw: { updateMany: (...a: unknown[]) => unknown } } };
    };
    await mongo.db.statuses.raw.updateMany(
      {},
      { $unset: { publicState: "" } },
      { bypassDocumentValidation: true },
    );
    const { statuses } = await statusesOf(kit);
    expect(named(statuses, "Done").publicState).toBe("resolved");
    expect(named(statuses, "Triage").publicState).toBe("received");
  });

  test("createStatus takes one or defaults; updateStatus sets it, and a category change moves a default one", async () => {
    const kit = await intakeKit();
    const made = await kit.asOwner.call<{ createStatus: StatusOut }>(
      CreateStatus,
      {
        input: {
          projectId: kit.project.id,
          name: "Waiting on vendor",
          category: "inProgress",
          colour: "#112233",
        },
      },
    );
    expect(made.createStatus.publicState).toBe("inProgress");
    const set = await kit.asOwner.call<{ updateStatus: StatusOut }>(
      UpdateStatus,
      { id: made.createStatus.id, input: { publicState: "received" } },
    );
    expect(set.updateStatus.publicState).toBe("received");
    // Customised: a new category leaves it alone.
    const kept = await kit.asOwner.call<{ updateStatus: StatusOut }>(
      UpdateStatus,
      { id: made.createStatus.id, input: { category: "done" } },
    );
    expect(kept.updateStatus.publicState).toBe("received");
    // A default one follows its category.
    const { statuses } = await statusesOf(kit);
    const todo = named(statuses, "Todo");
    const followed = await kit.asOwner.call<{ updateStatus: StatusOut }>(
      UpdateStatus,
      { id: todo.id, input: { category: "done" } },
    );
    expect(followed.updateStatus.publicState).toBe("resolved");
  });
});

describe("a report's public state", () => {
  test("a custom status maps, and its name never appears in a public read", async () => {
    const kit = await intakeKit();
    const secretName = "Escalated to legal";
    const { createStatus: custom } = await kit.asOwner.call<{
      createStatus: StatusOut;
    }>(CreateStatus, {
      input: {
        projectId: kit.project.id,
        name: secretName,
        category: "todo",
        colour: "#112233",
      },
    });
    await kit.asOwner.call(UpdateStatus, {
      id: custom.id,
      input: { publicState: "inProgress" },
    });
    const { id, token } = await withTracking(kit);
    expect((await tracked(kit, token))["publicState"]).toBe("received");
    const { acceptClientReport } = await accept(kit, id);
    expect(acceptClientReport.publicState).toBe("received");
    await move(kit, acceptClientReport.issueId as string, custom.id);

    const read = await kit.track(token);
    expect(read.body?.data?.["clientReportStatus"]).toMatchObject({
      publicState: "inProgress",
    });
    expect(JSON.stringify(read.body)).not.toContain(secretName);
    expect((await reportOf(kit, id)).publicState).toBe("inProgress");

    // Done maps to resolved, Cancelled to declined (no reason).
    const { statuses } = await statusesOf(kit);
    await move(
      kit,
      acceptClientReport.issueId as string,
      named(statuses, "Done").id,
    );
    expect((await tracked(kit, token))["publicState"]).toBe("resolved");
    await move(
      kit,
      acceptClientReport.issueId as string,
      named(statuses, "Cancelled").id,
    );
    const declined = await tracked(kit, token);
    expect(declined).toMatchObject({
      publicState: "declined",
      declineReason: null,
    });
  });

  test("the order rule of plan §19", () => {
    const base = { state: "accepted" as const };
    const at = (n: number) => new Date(2026, 0, n);
    expect(derivePublicState({ state: "new" }, null)).toBe("received");
    expect(derivePublicState(base, "inProgress")).toBe("inProgress");
    expect(derivePublicState({ state: "declined" }, "resolved")).toBe(
      "declined",
    );
    expect(derivePublicState(base, "declined")).toBe("declined");
    const resolved = { ...base, resolvedByReporterAt: at(2) };
    expect(derivePublicState(resolved, "inProgress")).toBe("resolved");
    // Reopened: in progress until the issue's mapped state changes.
    const reopened = {
      ...resolved,
      reopenedAt: at(3),
      reopenedFrom: "received" as const,
    };
    expect(derivePublicState(reopened, "received")).toBe("inProgress");
    expect(derivePublicState(reopened, "resolved")).toBe("resolved");
    // Resolved again after the reopen.
    expect(
      derivePublicState(
        { ...reopened, resolvedByReporterAt: at(4) },
        "received",
      ),
    ).toBe("resolved");
    // Its issue was deleted: settled, not "received".
    expect(derivePublicState({ ...base, issueId: new ObjectId() }, null)).toBe(
      "resolved",
    );
    // Declined wins over a reporter's resolve.
    expect(derivePublicState(resolved, "declined")).toBe("declined");
  });
});

describe("declineClientReport", () => {
  test("the reason is shown to the reporter for a new decline, and hidden for an earlier one", async () => {
    const kit = await intakeKit();
    const fresh = await withTracking(kit);
    const decline = await kit.asOwner.call<{
      declineClientReport: ReportOut;
    }>(Decline, { id: fresh.id, reason: "Not something we build" });
    expect(decline.declineClientReport).toMatchObject({
      state: "declined",
      declineReasonPublic: true,
      publicState: "declined",
    });
    expect(await tracked(kit, fresh.token)).toMatchObject({
      publicState: "declined",
      declineReason: "Not something we build",
    });

    // A report declined before widget v3 has no flag: its reason stays hidden.
    const old = await withTracking(kit);
    await kit.asOwner.call(Decline, { id: old.id, reason: "Spam, probably" });
    const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
      db: {
        clientReports: { raw: { updateOne: (...a: unknown[]) => unknown } };
      };
    };
    await mongo.db.clientReports.raw.updateOne(
      { _id: new ObjectId(old.id) },
      { $unset: { declineReasonPublic: "" } },
      { bypassDocumentValidation: true },
    );
    expect(await tracked(kit, old.token)).toMatchObject({
      publicState: "declined",
      declineReason: null,
    });
    const listed = await reportOf(kit, old.id);
    expect(listed.declineReasonPublic).toBe(false);
    expect(listed.declineReason).toBe("Spam, probably");
  });
});

describe("impact and type", () => {
  test("accept prefills the priority from the impact, with origin client, and adds the type label", async () => {
    const kit = await intakeKit();
    const id = await send(kit, { impact: "blocking", type: "bug" });
    expect(await reportOf(kit, id)).toMatchObject({
      impact: "blocking",
      type: "bug",
    });
    const { acceptClientReport } = await accept(kit, id);
    const issue = await issueOf(kit, acceptClientReport.issueId as string);
    expect(issue).toMatchObject({ priority: "high", priorityOrigin: "client" });
    const { labels } = await statusesOf(kit);
    expect(labels.map((label) => label.name)).toEqual(["Bug"]);
    expect(issue.labelIds).toEqual([labels[0]?.id as string]);

    // The label is made once, then reused.
    const second = await send(kit, { impact: "minor", type: "bug" });
    const again = await accept(kit, second);
    const other = await issueOf(
      kit,
      again.acceptClientReport.issueId as string,
    );
    expect(other).toMatchObject({ priority: "low", priorityOrigin: "client" });
    expect((await statusesOf(kit)).labels).toHaveLength(1);
    expect(other.labelIds).toEqual(issue.labelIds);

    // annoying maps to medium; a team's own label of the name is reused.
    const third = await send(kit, { impact: "annoying", type: "question" });
    const med = await accept(kit, third);
    expect(
      await issueOf(kit, med.acceptClientReport.issueId as string),
    ).toMatchObject({ priority: "medium", priorityOrigin: "client" });
  });

  test("the origin becomes team once a member changes the priority, not when it is sent unchanged", async () => {
    const kit = await intakeKit();
    const id = await send(kit, { impact: "annoying" });
    const { acceptClientReport } = await accept(kit, id);
    const issueId = acceptClientReport.issueId as string;
    await kit.asOwner.call(Update, {
      id: issueId,
      input: { priority: "medium" },
    });
    expect((await issueOf(kit, issueId)).priorityOrigin).toBe("client");
    await kit.asOwner.call(Update, {
      id: issueId,
      input: { priority: "urgent" },
    });
    expect(await issueOf(kit, issueId)).toMatchObject({
      priority: "urgent",
      priorityOrigin: "team",
    });
  });

  test("a report with neither keeps today's behaviour: no priority, no label, origin team", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const { acceptClientReport } = await accept(kit, id);
    expect(
      await issueOf(kit, acceptClientReport.issueId as string),
    ).toMatchObject({ priority: "none", priorityOrigin: "team", labelIds: [] });
    expect((await statusesOf(kit)).labels).toHaveLength(0);
  });

  test("the submit input refuses an unknown impact or type", async () => {
    const kit = await intakeKit();
    for (const extra of [{ impact: "huge" }, { type: "rant" }]) {
      const bad = await kit.submit(goodReport(extra));
      expect(bad.response.status).toBe(400);
      expect(bad.body?.errors?.length).toBeGreaterThan(0);
    }
  });
});

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
