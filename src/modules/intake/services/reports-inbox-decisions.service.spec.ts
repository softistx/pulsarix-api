import { describe, expect, test } from "bun:test";
import { ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { intakeKit } from "~/intake";
import { Accept, Decline, IssueByKey, Move, send } from "~/reports";
import { tenancy } from "../../../config/db";
import { registerIssueChange } from "../../issues/public";

describe("the inbox", () => {
  test("a step after followIssue that throws rolls the issueId back with the issue", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    // Registered after followIssue, so it runs after the issueId was written,
    // inside the same transaction.
    const unregister = registerIssueChange(async (_mongo, change) => {
      if (change.verb === "created" && change.issue.clientReportId) {
        throw new Error("a later step fails");
      }
    });
    try {
      await kit.asOwner.call(Accept, { id }).catch(() => undefined);
    } finally {
      unregister();
    }
    const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
      db: {
        clientReports: {
          findById: (
            id: string,
          ) => Promise<{ state: string; issueId: unknown } | null>;
        };
      };
    };
    expect(await mongo.db.clientReports.findById(id)).toMatchObject({
      state: "new",
      issueId: null,
    });
    // No issue was kept: the first key is still free.
    const retry = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id });
    expect(retry.acceptClientReport.issueId).toBeTruthy();
  });

  test("a report is decided once: a second accept or decline is a 409", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    await kit.asOwner.call(Accept, { id });
    expect(codeOf(await kit.asOwner.attempt(Accept, { id }))).toBe(
      "intake.errors.report-decided",
    );
    expect(
      codeOf(await kit.asOwner.attempt(Decline, { id, reason: "late" })),
    ).toBe("intake.errors.report-decided");
    // Two at once: one issue only.
    const other = await send(kit);
    const results = await Promise.all([
      kit.asOwner.attempt(Accept, { id: other }),
      kit.asOwner.attempt(Accept, { id: other }),
    ]);
    expect(results.filter((r) => !r.errors)).toHaveLength(1);
    const issues = await kit.asOwner.call<{ issue: { id: string } }>(
      IssueByKey,
      { key: "ABC-2" },
    );
    expect(issues.issue.id).toBeTruthy();
    expect(
      codeOf(await kit.asOwner.attempt(IssueByKey, { key: "ABC-3" })),
    ).toBe("issues.errors.not-found");
  });

  test("declining keeps the reason for the team", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const declined = await kit.asOwner.call<{
      declineClientReport: { id: string; state: string; declineReason: string };
    }>(Decline, {
      id,
      reason: "  Duplicate of ABC-9  ",
    });
    expect(declined.declineClientReport).toEqual({
      id,
      state: "declined",
      declineReason: "Duplicate of ABC-9",
    });
    expect(
      codeOf(
        await kit.asOwner.attempt(Decline, {
          id: await send(kit),
          reason: "   ",
        }),
      ),
    ).toBe("validation.errors.invalid-input");
  });

  test("another organisation decides none of these reports", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const stranger = await ownerWithOrganisation(kit.kit, "Elsewhere");
    const as = kit.kit.client(stranger.owner.token, {
      organisation: stranger.organisation.id,
    });
    expect(codeOf(await as.attempt(Accept, { id }))).toBe(
      "intake.errors.not-found",
    );
    expect(codeOf(await as.attempt(Decline, { id, reason: "no" }))).toBe(
      "intake.errors.not-found",
    );
  });

  test("a report follows its issue: done closes it, moving back reopens it", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id });
    const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
      db: {
        statuses: {
          findMany: (q: object) => Promise<{ id: string; category: string }[]>;
        };
        clientReports: {
          findById: (
            id: string,
          ) => Promise<{ state: string; closedAt: Date | null } | null>;
        };
      };
    };
    const statuses = await mongo.db.statuses.findMany({});
    const done = statuses.find((s) => s.category === "done")?.id as string;
    const todo = statuses.find((s) => s.category === "todo")?.id as string;
    await kit.asOwner.call(Move, {
      id: acceptClientReport.issueId,
      statusId: done,
    });
    const closed = await mongo.db.clientReports.findById(id);
    expect(closed?.state).toBe("closed");
    expect(closed?.closedAt).toBeInstanceOf(Date);
    await kit.asOwner.call(Move, {
      id: acceptClientReport.issueId,
      statusId: todo,
    });
    expect((await mongo.db.clientReports.findById(id))?.state).toBe("accepted");
    await kit.asOwner.call(`mutation($id: ID!) { deleteIssue(id: $id) }`, {
      id: acceptClientReport.issueId,
    });
    expect((await mongo.db.clientReports.findById(id))?.state).toBe("closed");
  });
});
