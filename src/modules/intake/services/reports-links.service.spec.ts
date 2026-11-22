import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { intakeKit } from "~/intake";
import {
  accept,
  Decline,
  IssueOf,
  type IssueOut,
  Link,
  reportOf,
  send,
} from "~/public-state";

const CreateIssues = `mutation($id: ID!, $issues: [NewIssueFromReportInput!]!) {
  createIssuesFromClientReport(id: $id, issues: $issues) {
    id state issueId issueIds issues { id type title }
  }
}`;
const ArchiveProject = `mutation($id: ID!) { archiveProject(id: $id) { id archivedAt } }`;
const Unlink = `mutation($id: ID!, $issueId: ID!) {
  unlinkClientReport(id: $id, issueId: $issueId) { id state issueId issueIds }
}`;
const OtherProject = `mutation {
  createProject(input: { key: "OTH", name: "Other" }) { id }
}`;
const OtherIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id }
}`;

interface Made {
  createIssuesFromClientReport: {
    id: string;
    state: string;
    issueId: string | null;
    issueIds: string[];
    issues: { id: string; type: string; title: string }[];
  };
}

const issuesOf = async (kit: Awaited<ReturnType<typeof intakeKit>>) =>
  (
    await kit.asOwner.call<{ issues: { nodes: IssueOut[] } }>(IssueOf, {
      id: kit.project.id,
    })
  ).issues.nodes;

describe("createIssuesFromClientReport", () => {
  test("three issues from one request in one call, typed, the first link is issueId", async () => {
    const kit = await intakeKit();
    const id = await send(kit, { type: "bug" });
    const { createIssuesFromClientReport: report } =
      await kit.asOwner.call<Made>(CreateIssues, {
        id,
        issues: [
          { title: "Fix the crash" },
          { title: "Add a test", type: "task" },
          { title: "Write the doc", type: "story" },
        ],
      });
    expect(report.state).toBe("accepted");
    expect(report.issues.map((i) => [i.title, i.type])).toEqual([
      ["Fix the crash", "bug"],
      ["Add a test", "task"],
      ["Write the doc", "story"],
    ]);
    expect(report.issueIds).toEqual(report.issues.map((i) => i.id));
    expect(report.issueId).toBe(report.issueIds[0] as string);
    expect(await issuesOf(kit)).toHaveLength(3);
  });

  test("all or nothing: a refused issue leaves the report new and no issue", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const refused = await kit.asOwner.attempt(CreateIssues, {
      id,
      issues: [
        { title: "Fine" },
        { title: "Bad parent", parentId: "0123456789abcdef01234567" },
      ],
    });
    expect(codeOf(refused)).toBeString();
    expect((await reportOf(kit, id)).state).toBe("new");
    expect(await issuesOf(kit)).toHaveLength(0);
    for (const issues of [
      [],
      Array.from({ length: 11 }, () => ({ title: "x" })),
    ]) {
      expect(
        codeOf(await kit.asOwner.attempt(CreateIssues, { id, issues })),
      ).toBe("validation.errors.invalid-input");
    }
  });

  test("a declined report makes no issue, an accepted one gains more", async () => {
    const kit = await intakeKit();
    const declined = await send(kit);
    await kit.asOwner.call(Decline, { id: declined, reason: "No" });
    expect(
      codeOf(
        await kit.asOwner.attempt(CreateIssues, {
          id: declined,
          issues: [{ title: "x" }],
        }),
      ),
    ).toBe("intake.errors.report-decided");
    const id = await send(kit);
    await accept(kit, id);
    const more = await kit.asOwner.call<Made>(CreateIssues, {
      id,
      issues: [{ title: "Another" }],
    });
    expect(more.createIssuesFromClientReport.issueIds).toHaveLength(2);
  });
});

describe("linkClientReport and unlinkClientReport", () => {
  test("links add up, the last one stays, issueId follows the earliest", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const { createIssuesFromClientReport: made } = await kit.asOwner.call<Made>(
      CreateIssues,
      { id, issues: [{ title: "One" }, { title: "Two" }] },
    );
    const [one, two] = made.issueIds as [string, string];
    expect(codeOf(await kit.asOwner.attempt(Link, { id, issueId: one }))).toBe(
      "intake.errors.link-exists",
    );

    // Another request linked to the same issue, then a second issue.
    const other = await send(kit);
    await kit.asOwner.call(Link, { id: other, issueId: one });
    await kit.asOwner.call(Link, { id: other, issueId: two });
    const gone = await kit.asOwner.call<{
      unlinkClientReport: { issueId: string; issueIds: string[] };
    }>(Unlink, { id: other, issueId: one });
    expect(gone.unlinkClientReport.issueIds).toEqual([two]);
    expect(gone.unlinkClientReport.issueId).toBe(two);
    expect(
      codeOf(await kit.asOwner.attempt(Unlink, { id: other, issueId: two })),
    ).toBe("intake.errors.last-link");
    expect(
      codeOf(await kit.asOwner.attempt(Unlink, { id: other, issueId: one })),
    ).toBe("intake.errors.not-found");
    // The first request still holds both.
    const first = await kit.asOwner.call<{
      unlinkClientReport: { issueIds: string[] };
    }>(Unlink, { id, issueId: one });
    expect(first.unlinkClientReport.issueIds).toEqual([two]);
  });

  test("two unlinks at once never leave a request without a link", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const { createIssuesFromClientReport: made } = await kit.asOwner.call<Made>(
      CreateIssues,
      {
        id,
        issues: [{ title: "One" }, { title: "Two" }],
      },
    );
    const [one, two] = made.issueIds as [string, string];
    const results = await Promise.all([
      kit.asOwner.attempt(Unlink, { id, issueId: one }),
      kit.asOwner.attempt(Unlink, { id, issueId: two }),
    ]);
    const refused = results.map((r) => codeOf(r)).filter(Boolean);
    // One unlink wins; the other is refused (last link) after its retry.
    expect(refused).toEqual(["intake.errors.last-link"]);
  });

  test("deleting the first issue keeps the request open on its other link", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const { createIssuesFromClientReport: made } = await kit.asOwner.call<Made>(
      CreateIssues,
      {
        id,
        issues: [{ title: "One" }, { title: "Two" }],
      },
    );
    const [one, two] = made.issueIds as [string, string];
    await kit.asOwner.call(`mutation($id: ID!) { deleteIssue(id: $id) }`, {
      id: one,
    });
    const after = await kit.asOwner
      .call<{
        unlinkClientReport: {
          state: string;
          issueId: string;
          issueIds: string[];
        };
      }>(Unlink, { id, issueId: two })
      .catch(() => null);
    // The last link cannot go; the report is read through its state instead.
    expect(after).toBeNull();
    const report = await reportOf(kit, id);
    expect(report.state).toBe("accepted");
    expect(report.issueId).toBe(two);
  });

  test("an archived project refuses link and unlink", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const { createIssuesFromClientReport: made } = await kit.asOwner.call<Made>(
      CreateIssues,
      {
        id,
        issues: [{ title: "One" }, { title: "Two" }],
      },
    );
    const [one] = made.issueIds as [string, string];
    await kit.asOwner.call(ArchiveProject, { id: kit.project.id });
    expect(
      codeOf(await kit.asOwner.attempt(Unlink, { id, issueId: one })),
    ).toBe("issues.errors.project-archived");
    expect(codeOf(await kit.asOwner.attempt(Link, { id, issueId: one }))).toBe(
      "issues.errors.project-archived",
    );
  });

  test("an issue of another project is refused and the report stays new", async () => {
    const kit = await intakeKit();
    const { createProject: project } = await kit.asOwner.call<{
      createProject: { id: string };
    }>(OtherProject);
    const { createIssue: issue } = await kit.asOwner.call<{
      createIssue: { id: string };
    }>(OtherIssue, { input: { projectId: project.id, title: "Elsewhere" } });
    const id = await send(kit);
    expect(
      codeOf(await kit.asOwner.attempt(Link, { id, issueId: issue.id })),
    ).toBe("intake.errors.issue-other-project");
    expect((await reportOf(kit, id)).state).toBe("new");
  });
});
