import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { intakeKit } from "~/intake";
import {
  accept,
  CreateStatus,
  Decline,
  move,
  named,
  type ReportOut,
  reportOf,
  type StatusOut,
  statusesOf,
  tracked,
  UpdateStatus,
  withTracking,
} from "~/public-state";
import { tenancy } from "../../../config/db";
import { derivePublicState } from "./public-state.service";

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
