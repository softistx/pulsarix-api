import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { codeOfBody, goodReport, type IntakeKit, intakeKit } from "~/intake";
import { coreMongo, tenancy } from "../../config/db";
import { registerIssueChange } from "../issues/public";

const Keys = `query($projectId: ID!) {
  widgetKeys(projectId: $projectId) {
    id projectId publicKey label allowedOrigins active lastUsedAt
  }
}`;
const Create = `mutation($input: CreateWidgetKeyInput!) {
  createWidgetKey(input: $input) { id publicKey label allowedOrigins active }
}`;
const Update = `mutation($id: ID!, $input: UpdateWidgetKeyInput!) {
  updateWidgetKey(id: $id, input: $input) { id label active allowedOrigins }
}`;
const Rotate = `mutation($id: ID!) { rotateWidgetKey(id: $id) { id publicKey } }`;
const Revoke = `mutation($id: ID!) { revokeWidgetKey(id: $id) }`;
const Reports = `query($projectId: ID!, $state: ClientReportState, $first: Int, $after: String) {
  clientReports(projectId: $projectId, state: $state, first: $first, after: $after) {
    nodes { id projectId title description email state issueId declineReason pageUrl userAgent locale metadata { key value } decidedBy decidedAt closedAt erasedAt }
    endCursor hasNextPage
  }
}`;
const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id state issueId decidedBy } }`;
const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id state declineReason }
}`;
const IssueByKey = `query($key: String!) {
  issue(key: $key) { id key title description statusId reporterId clientReportId }
}`;
const Move = `mutation($id: ID!, $statusId: ID!) { moveIssue(id: $id, statusId: $statusId) { id } }`;
const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;

interface Report {
  id: string;
  state: string;
  issueId: string | null;
  title: string;
}

async function send(kit: IntakeKit, extra: Record<string, unknown> = {}) {
  kit.limits &&
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
  const { body } = await kit.submit(goodReport(extra));
  const data = body?.data as unknown as {
    submitClientReport: { reportId: string };
  };
  return data.submitClientReport.reportId;
}

describe("widget keys", () => {
  test("an admin makes, lists, edits, rotates and revokes a key", async () => {
    const kit = await intakeKit();
    const admin = await memberWith(
      kit.kit,
      kit.organisation.id,
      kit.owner.token,
      "admin",
    );
    const asAdmin = kit.kit.client(admin.token, {
      organisation: kit.organisation.id,
    });
    const made = await asAdmin.call<{
      createWidgetKey: { id: string; publicKey: string; active: boolean };
    }>(Create, {
      input: {
        projectId: kit.project.id,
        label: " Docs ",
        allowedOrigins: ["https://docs.client.test"],
      },
    });
    expect(made.createWidgetKey.publicKey).toMatch(
      /^pk_live_[A-Za-z0-9_-]{32}$/,
    );
    expect(made.createWidgetKey.active).toBe(true);
    const listed = await asAdmin.call<{ widgetKeys: { label: string }[] }>(
      Keys,
      { projectId: kit.project.id },
    );
    expect(listed.widgetKeys.map((k) => k.label)).toEqual(["Site", "Docs"]);

    const updated = await asAdmin.call<{
      updateWidgetKey: { label: string; active: boolean };
    }>(Update, {
      id: made.createWidgetKey.id,
      input: { label: "Documentation", active: false },
    });
    expect(updated.updateWidgetKey).toMatchObject({
      label: "Documentation",
      active: false,
    });
    expect(
      codeOf(
        await asAdmin.attempt(Update, {
          id: made.createWidgetKey.id,
          input: { label: null },
        }),
      ),
    ).toBe("validation.errors.invalid-input");

    const rotated = await asAdmin.call<{
      rotateWidgetKey: { publicKey: string };
    }>(Rotate, {
      id: made.createWidgetKey.id,
    });
    expect(rotated.rotateWidgetKey.publicKey).not.toBe(
      made.createWidgetKey.publicKey,
    );
    // The old value is unknown from then on, the new one is the key.
    const old = await kit.config({}, made.createWidgetKey.publicKey);
    expect(codeOfBody(old.body)).toBe("intake.errors.unknown-key");

    await asAdmin.call(Revoke, { id: made.createWidgetKey.id });
    const after = await asAdmin.call<{ widgetKeys: { label: string }[] }>(
      Keys,
      { projectId: kit.project.id },
    );
    expect(after.widgetKeys.map((k) => k.label)).toEqual(["Site"]);
    expect(
      codeOf(await asAdmin.attempt(Revoke, { id: made.createWidgetKey.id })),
    ).toBe("intake.errors.key-not-found");
  });

  test("a member, a viewer and an anonymous caller manage no key", async () => {
    const kit = await intakeKit();
    for (const role of ["member", "viewer"] as const) {
      const who = await memberWith(
        kit.kit,
        kit.organisation.id,
        kit.owner.token,
        role,
      );
      const as = kit.kit.client(who.token, {
        organisation: kit.organisation.id,
      });
      expect(
        codeOf(await as.attempt(Keys, { projectId: kit.project.id })),
      ).toBe("auth.errors.forbidden");
      expect(
        codeOf(
          await as.attempt(Create, {
            input: {
              projectId: kit.project.id,
              label: "x",
              allowedOrigins: ["https://x.test"],
            },
          }),
        ),
      ).toBe("auth.errors.forbidden");
      expect(codeOf(await as.attempt(Revoke, { id: kit.key.id }))).toBe(
        "auth.errors.forbidden",
      );
    }
    expect(
      codeOf(
        await kit.kit.client().attempt(Keys, { projectId: kit.project.id }),
      ),
    ).toBe("auth.errors.unauthenticated");
  });

  test("creating or rotating a key asks for a recent proof of identity", async () => {
    const kit = await intakeKit();
    kit.kit.clock.advance(11 * 60_000);
    const as = kit.asOwner;
    expect(
      codeOf(
        await as.attempt(Create, {
          input: {
            projectId: kit.project.id,
            label: "x",
            allowedOrigins: ["https://x.test"],
          },
        }),
      ),
    ).toBe("auth.errors.step-up-required");
    expect(codeOf(await as.attempt(Rotate, { id: kit.key.id }))).toBe(
      "auth.errors.step-up-required",
    );
  });

  test("a key needs at least one origin, and a known project", async () => {
    const kit = await intakeKit();
    expect(
      codeOf(
        await kit.asOwner.attempt(Create, {
          input: { projectId: kit.project.id, label: "x", allowedOrigins: [] },
        }),
      ),
    ).toBe("validation.errors.invalid-input");
    expect(
      codeOf(
        await kit.asOwner.attempt(Create, {
          input: {
            projectId: "019a0000000070008000000a",
            label: "x",
            allowedOrigins: ["https://x.test"],
          },
        }),
      ),
    ).toBe("projects.errors.not-found");
  });

  test("another organisation's admin reads and touches none of these keys", async () => {
    const kit = await intakeKit();
    const stranger = await ownerWithOrganisation(kit.kit, "Elsewhere");
    const as = kit.kit.client(stranger.owner.token, {
      organisation: stranger.organisation.id,
    });
    expect(codeOf(await as.attempt(Keys, { projectId: kit.project.id }))).toBe(
      "projects.errors.not-found",
    );
    for (const attempt of [
      as.attempt(Update, { id: kit.key.id, input: { active: false } }),
      as.attempt(Rotate, { id: kit.key.id }),
      as.attempt(Revoke, { id: kit.key.id }),
    ]) {
      expect(codeOf(await attempt)).toBe("intake.errors.key-not-found");
    }
    const stored = await coreMongo.db.widgetKeys.findFirst({
      publicKey: kit.key.publicKey,
    });
    expect(stored?.active).toBe(true);
    expect(stored?.revokedAt).toBeNull();
  });
});

describe("the inbox", () => {
  async function inbox(kit: IntakeKit, vars: Record<string, unknown> = {}) {
    return (
      await kit.asOwner.call<{
        clientReports: {
          nodes: Report[];
          endCursor: string | null;
          hasNextPage: boolean;
        };
      }>(Reports, { projectId: kit.project.id, ...vars })
    ).clientReports;
  }

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

describe("the tracking page shows public replies only", () => {
  test("state and public replies; no private comment, author, issue or mention id", async () => {
    const kit = await intakeKit();
    await kit.submit(goodReport({ email: "reporter@client.test" }));
    await kit.intake.settled();
    const token = kit.mailer.sent[0]?.text.match(
      /\/track\/(\S+)/,
    )?.[1] as string;

    const received = await kit.track(token);
    expect(received.response.status).toBe(200);
    expect(received.body?.data).toMatchObject({
      clientReportStatus: {
        state: "new",
        title: "The save button does nothing",
        replies: [],
      },
    });
    expect(received.response.headers.get("referrer-policy")).toBe(
      "no-referrer",
    );
    expect(received.response.headers.get("x-robots-tag")).toBe("noindex");
    expect(received.response.headers.get("cache-control")).toBe("no-store");

    const list = await kit.asOwner.call<{ clientReports: { nodes: Report[] } }>(
      Reports,
      { projectId: kit.project.id },
    );
    const reportId = list.clientReports.nodes[0]?.id as string;
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, {
      id: reportId,
    });
    await kit.asOwner.call(AddComment, {
      issueId: acceptClientReport.issueId,
      input: { body: "Internal: the cause is the cache", public: false },
    });
    await kit.asOwner.call(AddComment, {
      issueId: acceptClientReport.issueId,
      input: {
        body: `Thanks, fixing it. cc @[Steve](${kit.owner.id})`,
        public: true,
      },
    });
    const tracked = await kit.track(token);
    const data = tracked.body?.data as unknown as {
      clientReportStatus: {
        state: string;
        replies: { at: string; body: string }[];
      };
    };
    expect(data.clientReportStatus.state).toBe("accepted");
    expect(data.clientReportStatus.replies).toHaveLength(1);
    expect(data.clientReportStatus.replies[0]?.body).toBe(
      "Thanks, fixing it. cc @Steve",
    );
    const text = JSON.stringify(tracked.body);
    expect(text).not.toContain("Internal");
    expect(text).not.toContain(kit.owner.id);
    expect(text).not.toContain(acceptClientReport.issueId);
    expect(text).not.toContain("authorId");
  });

  test("a declined report shows its state, not the team's reason", async () => {
    const kit = await intakeKit();
    await kit.submit(goodReport({ email: "reporter@client.test" }));
    await kit.intake.settled();
    const token = kit.mailer.sent[0]?.text.match(
      /\/track\/(\S+)/,
    )?.[1] as string;
    const list = await kit.asOwner.call<{ clientReports: { nodes: Report[] } }>(
      Reports,
      { projectId: kit.project.id },
    );
    await kit.asOwner.call(Decline, {
      id: list.clientReports.nodes[0]?.id,
      reason: "Secret internal reason",
    });
    const tracked = await kit.track(token);
    expect(tracked.body?.data).toMatchObject({
      clientReportStatus: { state: "declined" },
    });
    expect(JSON.stringify(tracked.body)).not.toContain("Secret");
  });

  test("it is for the UI server: a browser origin, a missing client header, a bad or foreign token are refused", async () => {
    const kit = await intakeKit();
    await kit.submit(goodReport({ email: "reporter@client.test" }));
    await kit.intake.settled();
    const token = kit.mailer.sent[0]?.text.match(
      /\/track\/(\S+)/,
    )?.[1] as string;
    const fromBrowser = await kit.op(
      "clientReportStatus",
      { token },
      { "x-pulsarix-client": "x" },
    );
    expect(fromBrowser.response.status).toBe(403);
    expect(
      fromBrowser.response.headers.get("access-control-allow-origin"),
    ).toBeNull();
    const noHeader = await kit.op(
      "clientReportStatus",
      { token },
      { origin: null },
    );
    expect(noHeader.response.status).toBe(403);
    const secret = token.split(".")[1] as string;
    const other = await intakeKit();
    for (const bad of [
      "",
      "nonsense",
      `${kit.organisation.id}.${"A".repeat(43)}`,
      `${other.organisation.id}.${secret}`,
      `${kit.organisation.id}.${secret}.extra`,
      `${"0".repeat(24)}.${secret}`,
    ]) {
      const { response, body } = await kit.track(bad);
      expect(response.status).toBe(404);
      expect(codeOfBody(body)).toBe("intake.errors.not-found");
    }
  });
});
