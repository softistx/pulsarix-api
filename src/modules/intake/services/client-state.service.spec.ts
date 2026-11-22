import { describe, expect, test } from "bun:test";
import { memberWith } from "~/auth";
import { codeOf } from "~/http";
import { Move, world } from "~/notify";
import { named, type StatusOut, send, statusesOf } from "~/public-state";
import { Accept as AcceptReport, world as threadWorld } from "~/thread";

const CreateIssues = `mutation($id: ID!, $issues: [NewIssueFromReportInput!]!) {
  createIssuesFromClientReport(id: $id, issues: $issues) { id issueIds }
}`;
const Link = `mutation($id: ID!, $issueId: ID!) {
  linkClientReport(id: $id, issueId: $issueId) { id issueIds }
}`;
const State = `query($id: ID!) {
  clientReports(projectId: $id) { nodes { id state publicState } }
}`;
const IssueReports = `query($id: ID!) {
  issues(projectId: $id) { nodes { id waitingClients clientReports { id title publicState clientWaiting } } }
}`;
const Delete = `mutation($id: ID!) { deleteIssue(id: $id) }`;

type World = Awaited<ReturnType<typeof world>>;

// A request with an e-mail, made into two issues (A24): its links.
async function twoIssues(w: World) {
  w.clearIp();
  const reportId = await send(w.kit, { email: "r@client.test" });
  await w.kit.intake.settled();
  const made = await w.kit.asOwner.call<{
    createIssuesFromClientReport: { issueIds: string[] };
  }>(CreateIssues, {
    id: reportId,
    issues: [{ title: "First part" }, { title: "Second part" }],
  });
  const [a, b] = made.createIssuesFromClientReport.issueIds as [string, string];
  const { statuses } = await statusesOf(w.kit);
  w.kit.mailer.clear();
  w.fake.jobs.clear();
  return { reportId, a, b, statuses };
}
const stateOf = async (w: World, id: string) =>
  (
    await w.kit.asOwner.call<{
      clientReports: {
        nodes: { id: string; state: string; publicState: string }[];
      };
    }>(State, { id: w.kit.project.id })
  ).clientReports.nodes.find((node) => node.id === id);
const go = (w: World, issueId: string, status: StatusOut) =>
  w.kit.asOwner.call(Move, { id: issueId, statusId: status.id });

describe("client state from linked issues", () => {
  test("one issue done leaves the request open, both done resolve it and mail once", async () => {
    const w = await world();
    try {
      const { reportId, a, b, statuses } = await twoIssues(w);
      await go(w, a, named(statuses, "Done"));
      expect(await stateOf(w, reportId)).toMatchObject({
        state: "accepted",
        publicState: "received",
      });
      await go(w, b, named(statuses, "In progress"));
      expect((await stateOf(w, reportId))?.publicState).toBe("inProgress");
      await go(w, b, named(statuses, "Done"));
      expect(await stateOf(w, reportId)).toMatchObject({
        state: "closed",
        publicState: "resolved",
      });
      expect(w.fake.jobs.size).toBeGreaterThan(0);
      expect(await w.run(reportId)).toBe("sent");
      expect(w.kit.mailer.sent).toHaveLength(1);
      expect(await w.run(reportId)).not.toBe("sent");
      expect(w.kit.mailer.sent).toHaveLength(1);
    } finally {
      w.restore();
    }
  });

  test("two issues finishing at once close the request and notify the client once", async () => {
    const w = await world();
    try {
      const { reportId, a, b, statuses } = await twoIssues(w);
      const done = named(statuses, "Done");
      await Promise.all([go(w, a, done), go(w, b, done)]);
      expect(await stateOf(w, reportId)).toMatchObject({
        state: "closed",
        publicState: "resolved",
      });
      expect(w.fake.jobs.size).toBe(1);
      expect(await w.run(reportId)).toBe("sent");
      expect(await w.run(reportId)).not.toBe("sent");
      expect(w.kit.mailer.sent).toHaveLength(1);
    } finally {
      w.restore();
    }
  });

  test("an issue moved back reopens a closed request", async () => {
    const w = await world();
    try {
      const { reportId, a, b, statuses } = await twoIssues(w);
      await go(w, a, named(statuses, "Done"));
      await go(w, b, named(statuses, "Done"));
      expect((await stateOf(w, reportId))?.state).toBe("closed");
      await go(w, a, named(statuses, "In progress"));
      expect(await stateOf(w, reportId)).toMatchObject({
        state: "accepted",
        publicState: "inProgress",
      });
    } finally {
      w.restore();
    }
  });

  test("a cancelled issue counts as declined: the rest decides", async () => {
    const w = await world();
    try {
      const { reportId, a, b, statuses } = await twoIssues(w);
      await go(w, a, named(statuses, "Cancelled"));
      expect((await stateOf(w, reportId))?.publicState).toBe("received");
      await go(w, b, named(statuses, "Done"));
      expect(await stateOf(w, reportId)).toMatchObject({
        state: "closed",
        publicState: "resolved",
      });
    } finally {
      w.restore();
    }
  });

  test("deleting one of two issues lets the other settle the request", async () => {
    const w = await world();
    try {
      const { reportId, a, b, statuses } = await twoIssues(w);
      await go(w, a, named(statuses, "Done"));
      await w.kit.asOwner.call(Delete, { id: b });
      expect(await stateOf(w, reportId)).toMatchObject({
        state: "closed",
        publicState: "resolved",
      });
    } finally {
      w.restore();
    }
  });

  test("waitingClients counts the requests not settled and drops as they settle", async () => {
    const w = await world();
    try {
      const { reportId, a, b, statuses } = await twoIssues(w);
      w.clearIp();
      const other = await send(w.kit, { email: "o@client.test" });
      await w.kit.asOwner.call(Link, { id: other, issueId: a });
      const read = async () => {
        const { issues } = await w.kit.asOwner.call<{
          issues: {
            nodes: {
              id: string;
              waitingClients: number;
              clientReports: { id: string }[];
            }[];
          };
        }>(IssueReports, { id: w.kit.project.id });
        return (id: string) => issues.nodes.find((n) => n.id === id);
      };
      let of = await read();
      expect(of(a)?.waitingClients).toBe(2);
      expect(of(b)?.waitingClients).toBe(1);
      expect(
        of(a)
          ?.clientReports.map((r) => r.id)
          .sort(),
      ).toEqual([reportId, other].sort());
      await go(w, a, named(statuses, "Done"));
      of = await read();
      // The second request is resolved; the first still waits on B.
      expect(of(a)?.waitingClients).toBe(1);
      expect(of(b)?.waitingClients).toBe(1);
      await go(w, b, named(statuses, "Done"));
      of = await read();
      expect(of(a)?.waitingClients).toBe(0);
      expect(of(b)?.waitingClients).toBe(0);
    } finally {
      w.restore();
    }
  });

  test("clientReports is a team read; waitingClients any reader's", async () => {
    const w = await world();
    try {
      const { a } = await twoIssues(w);
      const viewer = await memberWith(
        w.kit.kit,
        w.kit.organisation.id,
        w.kit.owner.token,
        "viewer",
      );
      const asViewer = w.kit.kit.client(viewer.token, {
        organisation: w.kit.organisation.id,
      });
      const refused = await asViewer.attempt(IssueReports, {
        id: w.kit.project.id,
      });
      expect(codeOf(refused)).toBeString();
      const count = await asViewer.attempt(
        `query($id: ID!) { issues(projectId: $id) { nodes { id waitingClients } } }`,
        { id: w.kit.project.id },
      );
      expect(count.errors).toBeUndefined();
      expect(a).toBeString();
    } finally {
      w.restore();
    }
  });

  test("two reporters sharing an issue never read each other's thread", async () => {
    const t = await threadWorld();
    const one = await t.host.file("u1");
    const two = await t.host.file("u2");
    const { acceptClientReport } = await t.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(AcceptReport, { id: one });
    const issueId = acceptClientReport.issueId;
    await t.kit.asOwner.call(Link, { id: two, issueId });
    await t.say("u1", one, "Private words of the first");
    await t.say("u2", two, "Private words of the second");
    await t.comment(issueId, "Public answer to both", true);
    const first = JSON.stringify(await t.thread("u1", one));
    const second = JSON.stringify(await t.thread("u2", two));
    expect(first).toContain("Public answer to both");
    expect(first).toContain("Private words of the first");
    expect(first).not.toContain("Private words of the second");
    expect(second).toContain("Public answer to both");
    expect(second).toContain("Private words of the second");
    expect(second).not.toContain("Private words of the first");
  });
});
