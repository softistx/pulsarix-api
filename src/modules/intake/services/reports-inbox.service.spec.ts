import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { memberWith } from "~/auth";
import { codeOf } from "~/http";
import { intakeKit } from "~/intake";
import {
  Accept,
  Decline,
  IssueByKey,
  inbox,
  type Report,
  Reports,
  send,
} from "~/reports";
import { tenancy } from "../../../config/db";

describe("the inbox", () => {
  test("reports list newest first, by state, paged", async () => {
    const kit = await intakeKit();
    const ids = [
      await send(kit, { title: "one" }),
      await send(kit, { title: "two" }),
      await send(kit, { title: "three" }),
    ];
    const first = await inbox(kit, { first: 2 });
    expect(first.nodes.map((r) => r.title)).toEqual(["three", "two"]);
    expect(first.hasNextPage).toBe(true);
    const next = await inbox(kit, { first: 2, after: first.endCursor });
    expect(next.nodes.map((r) => r.id)).toEqual([ids[0] as string]);
    await kit.asOwner.call(Decline, {
      id: ids[1] as string,
      reason: "Not ours",
    });
    expect(
      (await inbox(kit, { state: "declined" })).nodes.map((r) => r.title),
    ).toEqual(["two"]);
    expect((await inbox(kit, { state: "new" })).nodes).toHaveLength(2);
    expect(
      codeOf(
        await kit.asOwner.attempt(Reports, {
          projectId: kit.project.id,
          first: 101,
        }),
      ),
    ).toBe("validation.errors.invalid-input");
  });

  test("a viewer reads no report; a member who writes issues does", async () => {
    const kit = await intakeKit();
    await send(kit);
    const viewer = await memberWith(
      kit.kit,
      kit.organisation.id,
      kit.owner.token,
      "viewer",
    );
    const asViewer = kit.kit.client(viewer.token, {
      organisation: kit.organisation.id,
    });
    expect(
      codeOf(await asViewer.attempt(Reports, { projectId: kit.project.id })),
    ).toBe("auth.errors.forbidden");
    const member = await memberWith(
      kit.kit,
      kit.organisation.id,
      kit.owner.token,
      "member",
    );
    const asMember = kit.kit.client(member.token, {
      organisation: kit.organisation.id,
    });
    const read = await asMember.call<{ clientReports: { nodes: Report[] } }>(
      Reports,
      { projectId: kit.project.id },
    );
    expect(read.clientReports.nodes).toHaveLength(1);
  });

  test("accepting makes an issue in Triage, linked both ways", async () => {
    const kit = await intakeKit();
    const id = await send(kit, {
      title: "Crash on save",
      description: "Steps: ...",
    });
    const accepted = await kit.asOwner.call<{
      acceptClientReport: { state: string; issueId: string; decidedBy: string };
    }>(Accept, { id });
    expect(accepted.acceptClientReport).toMatchObject({
      state: "accepted",
      decidedBy: kit.owner.id,
    });
    const issue = await kit.asOwner.call<{
      issue: {
        id: string;
        title: string;
        description: string;
        statusId: string;
        clientReportId: string;
      };
    }>(IssueByKey, { key: "ABC-1" });
    expect(issue.issue).toMatchObject({
      id: accepted.acceptClientReport.issueId,
      title: "Crash on save",
      description: "Steps: ...",
      clientReportId: id,
    });
    const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
      db: {
        statuses: {
          findById: (id: string) => Promise<{ category: string } | null>;
        };
      };
    };
    expect(
      (await mongo.db.statuses.findById(issue.issue.statusId))?.category,
    ).toBe("triage");
  });

  test("a created issue always has the report's issueId, set in its own transaction", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const accepted = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id });
    const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
      db: {
        clientReports: {
          findById: (
            id: string,
          ) => Promise<{ issueId: { toHexString(): string } | null } | null>;
        };
      };
    };
    expect(
      (await mongo.db.clientReports.findById(id))?.issueId?.toHexString(),
    ).toBe(accepted.acceptClientReport.issueId);
  });

  test("a failed creation puts the report back to new, without an issueId", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const mongo = (await tenancy.databaseOf(kit.organisation.id)) as never as {
      db: {
        clientReports: {
          update: (
            id: string,
            patch: Record<string, unknown>,
          ) => Promise<unknown>;
          findById: (id: string) => Promise<{
            state: string;
            issueId: unknown;
            decidedBy: unknown;
          } | null>;
        };
      };
    };
    // The report points at a project that no longer exists: the issue cannot be made.
    await mongo.db.clientReports.update(id, { projectId: new ObjectId() });
    await kit.asOwner.call(Accept, { id }).catch(() => undefined);
    const after = await mongo.db.clientReports.findById(id);
    expect(after).toMatchObject({
      state: "new",
      issueId: null,
      decidedBy: null,
    });
  });
});
