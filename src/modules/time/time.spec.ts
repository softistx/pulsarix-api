import { beforeAll, describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation, proveEmail } from "~/auth";
import { createFakeChronixLink } from "~/chronix";
import { codeOf } from "~/http";
import { useChronix } from "./chronix.client";
import { openLinkKey, sealLinkKey } from "./time.seal";

const fake = createFakeChronixLink({ organisationName: "Acme Time" });
const kit = authApp({ chronix: fake.factory });
beforeAll(() => useChronix(fake.factory));

const KEY = "chx_link_good";
const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id key }
}`;
const Create = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key title estimateHours }
}`;
const Update = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { estimateHours }
}`;
const Link = `mutation($key: String!) { linkChronix(key: $key) { linked organisationName } }`;
const Unlink = `mutation { unlinkChronix { linked organisationName } }`;
const TimeLink = `{ timeLink { linked organisationName } }`;
const Issue = `query($key: String!) { issue(key: $key) {
  key title estimateHours
  timeSpent { status totalSeconds mySeconds entryCount running } } }`;
const List = `query($projectId: ID!) { issues(projectId: $projectId) {
  nodes { key timeSpent { status totalSeconds } } } }`;
const Start = `mutation($issueId: ID!) { startIssueTimer(issueId: $issueId) { startedAt stoppedSeconds } }`;
const Log = `mutation($issueId: ID!, $input: LogIssueTimeInput!) {
  logIssueTime(issueId: $issueId, input: $input) { id date durationSeconds billable }
}`;

interface TimeSpent {
  status: string;
  totalSeconds: number | null;
  mySeconds: number | null;
  entryCount: number | null;
  running: boolean | null;
}

// An organisation with a project, two issues, an admin (the owner), a member
// and a viewer; linked to chronix unless `linked` is false.
async function setup(linked = true, proveOwner = true) {
  fake.comeUp();
  fake.setMembers(null);
  const { owner, organisation } = await ownerWithOrganisation(kit);
  fake.issueKey(KEY, { organisationId: organisation.id });
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  const member = await memberWith(kit, organisation.id, owner.token, "member");
  const viewer = await memberWith(kit, organisation.id, owner.token, "viewer");
  if (proveOwner) await proveEmail(kit, owner.email);
  const asMember = kit.client(member.token, { organisation: organisation.id });
  const asViewer = kit.client(viewer.token, { organisation: organisation.id });
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string; key: string };
  }>(CreateProject, { input: { key: "TIM", name: "Timed" } });
  const make = async (title: string, extra: Record<string, unknown> = {}) =>
    (
      await asOwner.call<{
        createIssue: { id: string; key: string; estimateHours: number | null };
      }>(Create, { input: { projectId: project.id, title, ...extra } })
    ).createIssue;
  if (linked) await asOwner.call(Link, { key: KEY });
  return {
    organisation,
    owner,
    member,
    viewer,
    asOwner,
    asMember,
    asViewer,
    project,
    make,
  };
}

describe("the estimate", () => {
  test("is set on create, changed and cleared on update, and bounded", async () => {
    const { asOwner, make } = await setup(false);
    const issue = await make("Estimated", { estimateHours: 2.5 });
    expect(issue.estimateHours).toBe(2.5);
    const set = await asOwner.call<{ updateIssue: { estimateHours: number } }>(
      Update,
      { id: issue.id, input: { estimateHours: 8 } },
    );
    expect(set.updateIssue.estimateHours).toBe(8);
    const cleared = await asOwner.call<{
      updateIssue: { estimateHours: number | null };
    }>(Update, { id: issue.id, input: { estimateHours: null } });
    expect(cleared.updateIssue.estimateHours).toBeNull();
    const refused = await asOwner.attempt(Update, {
      id: issue.id,
      input: { estimateHours: -1 },
    });
    expect(codeOf(refused)).toBe("validation.errors.invalid-input");
    expect((await make("Plain")).estimateHours).toBeNull();
  });
});

describe("the organisation's link", () => {
  test("an admin links it; only linked and the chronix name come back", async () => {
    const { asOwner, asMember } = await setup(false);
    expect(
      (await asOwner.call<{ timeLink: unknown }>(TimeLink)).timeLink,
    ).toEqual({ linked: false, organisationName: null });
    const linked = await asOwner.call<{ linkChronix: unknown }>(Link, {
      key: KEY,
    });
    expect(linked.linkChronix).toEqual({
      linked: true,
      organisationName: "Acme Time",
    });
    // A member reads it, and the key is not a field of the schema at all.
    expect(
      (await asMember.call<{ timeLink: { linked: boolean } }>(TimeLink))
        .timeLink.linked,
    ).toBe(true);
    const probe = await asOwner.attempt(`{ timeLink { sealedKey key } }`);
    expect(probe.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(linked)).not.toContain(KEY);
  });

  test("a member cannot link or unlink; a refused key is 400 invalid-key", async () => {
    const { asOwner, asMember, asViewer } = await setup(false);
    expect(codeOf(await asMember.attempt(Link, { key: KEY }))).toBe(
      "auth.errors.forbidden",
    );
    expect(codeOf(await asViewer.attempt(Unlink))).toBe(
      "auth.errors.forbidden",
    );
    const bad = await asOwner.attempt(Link, { key: "chx_link_wrong" });
    expect(codeOf(bad)).toBe("time.errors.invalid-key");
    expect(
      (await asOwner.call<{ timeLink: { linked: boolean } }>(TimeLink)).timeLink
        .linked,
    ).toBe(false);
  });

  test("a key made for another application or organisation is refused", async () => {
    const { asOwner, organisation } = await setup(false);
    fake.issueKey("chx_link_other_app", {
      organisationId: organisation.id,
      app: "operix",
    });
    fake.issueKey("chx_link_other_org", { organisationId: "someone-else" });
    for (const key of ["chx_link_other_app", "chx_link_other_org"]) {
      expect(codeOf(await asOwner.attempt(Link, { key }))).toBe(
        "time.errors.key-mismatch",
      );
    }
    expect(
      (await asOwner.call<{ timeLink: { linked: boolean } }>(TimeLink)).timeLink
        .linked,
    ).toBe(false);
  });

  test("linking and unlinking ask for a fresh session", async () => {
    const { asOwner } = await setup(false);
    kit.clock.advance(11 * 60 * 1000);
    expect(codeOf(await asOwner.attempt(Link, { key: KEY }))).toBe(
      "auth.errors.step-up-required",
    );
    expect(codeOf(await asOwner.attempt(Unlink))).toBe(
      "auth.errors.step-up-required",
    );
  });

  test("linking while chronix is down is 503, and unlinking forgets the key", async () => {
    const { asOwner } = await setup(false);
    fake.goDown();
    expect(codeOf(await asOwner.attempt(Link, { key: KEY }))).toBe(
      "time.errors.unavailable",
    );
    fake.comeUp();
    await asOwner.call(Link, { key: KEY });
    const gone = await asOwner.call<{ unlinkChronix: { linked: boolean } }>(
      Unlink,
    );
    expect(gone.unlinkChronix.linked).toBe(false);
  });

  test("the key is sealed: it opens only for its organisation and fails when tampered", () => {
    const sealed = sealLinkKey(KEY, "org-1");
    expect(sealed).not.toContain(KEY);
    expect(openLinkKey(sealed, "org-1")).toBe(KEY);
    expect(openLinkKey(sealed, "org-2")).toBeNull();
    expect(openLinkKey(`${sealed}x`, "org-1")).toBeNull();
    expect(openLinkKey("junk", "org-1")).toBeNull();
  });
});

describe("the time spent", () => {
  test("is UNLINKED without a link, with no numbers", async () => {
    const { asOwner, make } = await setup(false);
    const issue = await make("No link");
    const read = await asOwner.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(read.issue.timeSpent).toEqual({
      status: "UNLINKED",
      totalSeconds: null,
      mySeconds: null,
      entryCount: null,
      running: null,
    });
  });

  test("reads the totals from chronix, with the viewer's own share", async () => {
    const { asOwner, asMember, project, make } = await setup();
    fake.mapProject(project.id);
    const issue = await make("Tracked");
    await asOwner.call(Log, {
      issueId: issue.id,
      input: { date: "2026-11-13", durationSeconds: 3600 },
    });
    await asMember.call(Log, {
      issueId: issue.id,
      input: { date: "2026-11-13", durationSeconds: 1800 },
    });
    const mine = await asMember.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(mine.issue.timeSpent).toEqual({
      status: "AVAILABLE",
      totalSeconds: 5400,
      mySeconds: 1800,
      entryCount: 2,
      running: false,
    });
  });

  test("a list of issues asks chronix once", async () => {
    const { asOwner, project, make } = await setup();
    await make("One");
    await make("Two");
    await make("Three");
    fake.calls.length = 0;
    const list = await asOwner.call<{
      issues: { nodes: { timeSpent: { status: string } }[] };
    }>(List, { projectId: project.id });
    expect(list.issues.nodes.map((n) => n.timeSpent.status)).toEqual([
      "AVAILABLE",
      "AVAILABLE",
      "AVAILABLE",
    ]);
    expect(fake.calls.filter((c) => c.op === "totals")).toHaveLength(1);
  });

  test("a chronix outage leaves the issue page working: time unavailable, no error", async () => {
    const { asOwner, project, make } = await setup();
    fake.mapProject(project.id);
    const issue = await make("During an outage", { estimateHours: 3 });
    fake.goDown();
    const read = await asOwner.attempt<{
      issue: {
        key: string;
        title: string;
        estimateHours: number;
        timeSpent: TimeSpent;
      };
    }>(Issue, { key: issue.key });
    expect(read.errors).toBeUndefined();
    expect(read.data?.issue).toMatchObject({
      key: issue.key,
      title: "During an outage",
      estimateHours: 3,
      timeSpent: {
        status: "UNAVAILABLE",
        totalSeconds: null,
        mySeconds: null,
        entryCount: null,
        running: null,
      },
    });
    const list = await asOwner.attempt<{
      issues: { nodes: { key: string; timeSpent: { status: string } }[] };
    }>(List, { projectId: project.id });
    expect(list.errors).toBeUndefined();
    expect(list.data?.issues.nodes[0]?.timeSpent.status).toBe("UNAVAILABLE");
    // And it comes back by itself.
    fake.comeUp();
    const again = await asOwner.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(again.issue.timeSpent.status).toBe("AVAILABLE");
  });

  test("a revoked key degrades to UNAVAILABLE as well", async () => {
    const { asOwner, make } = await setup();
    const issue = await make("Revoked");
    fake.revokeKey(KEY);
    const read = await asOwner.attempt<{
      issue: { timeSpent: TimeSpent };
    }>(Issue, { key: issue.key });
    expect(read.errors).toBeUndefined();
    expect(read.data?.issue.timeSpent.status).toBe("UNAVAILABLE");
    fake.restoreKey(KEY);
  });
});

describe("the timer and the manual log", () => {
  test("startIssueTimer passes the member's verified e-mail and the issue as reference", async () => {
    const { member, asMember, project, make } = await setup();
    fake.mapProject(project.id);
    const issue = await make("Fix the login");
    fake.calls.length = 0;
    const started = await asMember.call<{
      startIssueTimer: { startedAt: string; stoppedSeconds: number | null };
    }>(Start, { issueId: issue.id });
    expect(started.startIssueTimer.stoppedSeconds).toBeNull();
    const call = fake.calls.find((c) => c.op === "startTimer");
    expect(call).toMatchObject({
      key: KEY,
      actor: member.email,
      input: {
        partnerProjectId: project.id,
        externalRef: {
          kind: "issue",
          id: issue.id,
          label: `${issue.key} Fix the login`,
        },
      },
    });
    const input = call?.input as { externalRef: { url: string } } | undefined;
    expect(input?.externalRef.url).toContain(`/issues/${issue.key}`);
    // A second timer stops the first: its seconds are told.
    const second = await make("Another");
    const next = await asMember.call<{
      startIssueTimer: { stoppedSeconds: number | null };
    }>(Start, { issueId: second.id });
    expect(next.startIssueTimer.stoppedSeconds).toBe(600);
  });

  test("an unverified e-mail cannot start or log, and the time reads FORBIDDEN without a call", async () => {
    // The owner signed up and has not proven the address.
    const { asOwner, project, make } = await setup(true, false);
    fake.mapProject(project.id);
    const issue = await make("Unverified");
    const started = await asOwner.attempt(Start, { issueId: issue.id });
    expect(codeOf(started)).toBe("time.errors.email-unverified");
    const logged = await asOwner.attempt(Log, {
      issueId: issue.id,
      input: { date: "2026-11-02", durationSeconds: 600 },
    });
    expect(codeOf(logged)).toBe("time.errors.email-unverified");
    fake.calls.length = 0;
    const read = await asOwner.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(read.issue.timeSpent.status).toBe("FORBIDDEN");
    expect(read.issue.timeSpent.totalSeconds).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("an account that is not a member in chronix: FORBIDDEN on reads, forbidden on writes", async () => {
    const { member, asMember, project, make } = await setup();
    fake.mapProject(project.id);
    const issue = await make("Not a member");
    fake.setMembers(["someone-else@example.test"]);
    const read = await asMember.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(read.issue.timeSpent.status).toBe("FORBIDDEN");
    expect(read.issue.timeSpent.totalSeconds).toBeNull();
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.forbidden",
    );
    expect(
      codeOf(
        await asMember.attempt(Log, {
          issueId: issue.id,
          input: { date: "2026-11-02", durationSeconds: 600 },
        }),
      ),
    ).toBe("time.errors.forbidden");
    fake.setMembers([member.email]);
    const back = await asMember.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(back.issue.timeSpent.status).toBe("AVAILABLE");
  });

  test("logIssueTime logs on the issue, as the acting member", async () => {
    const { member, asMember, project, make } = await setup();
    fake.mapProject(project.id);
    const issue = await make("Log me");
    fake.calls.length = 0;
    const logged = await asMember.call<{
      logIssueTime: { date: string; durationSeconds: number };
    }>(Log, {
      issueId: issue.id,
      input: { date: "2026-11-12", durationSeconds: 1800, billable: false },
    });
    expect(logged.logIssueTime).toMatchObject({
      date: "2026-11-12",
      durationSeconds: 1800,
      billable: false,
    });
    expect(fake.calls.find((c) => c.op === "logTime")).toMatchObject({
      actor: member.email,
      input: { externalRef: { kind: "issue", id: issue.id } },
    });
  });

  test("refusals: not linked, not mapped, locked period, viewer, outage", async () => {
    const { asOwner, asMember, asViewer, project, make } = await setup();
    const issue = await make("Edge cases");
    // chronix has no mapping for the project yet.
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.project-not-mapped",
    );
    fake.mapProject(project.id);
    fake.lockPeriod("2026-01-01");
    expect(
      codeOf(
        await asMember.attempt(Log, {
          issueId: issue.id,
          input: { date: "2026-01-01", durationSeconds: 600 },
        }),
      ),
    ).toBe("time.errors.period-locked");
    // A viewer reads time, never writes it.
    expect(codeOf(await asViewer.attempt(Start, { issueId: issue.id }))).toBe(
      "auth.errors.forbidden",
    );
    // chronix down: a mutation says 503, it cannot pretend.
    fake.goDown();
    const down = await asMember.attempt(Start, { issueId: issue.id });
    expect(codeOf(down)).toBe("time.errors.unavailable");
    fake.comeUp();
    // Unlinked: nothing to call.
    await asOwner.call(Unlink);
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.not-linked",
    );
    // Out-of-range durations are refused before chronix is asked.
    expect(
      (
        await asMember.attempt(Log, {
          issueId: issue.id,
          input: { date: "2026-11-13", durationSeconds: 5 },
        })
      ).errors?.length,
    ).toBeGreaterThan(0);
  });
});
