import { beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
  createFakeChronixLink,
  type FakeChronixLink,
  type FakeChronixLinkOptions,
} from "@softistx/chronix-react/server/testing";
import { parseSealingKeys } from "@softistx/janus";
import { authApp, memberWith, ownerWithOrganisation, proveEmail } from "~/auth";
import { codeOf } from "~/http";
import { env } from "../../config/env";
import { useChronix } from "./chronix.client";
import { openLinkKey, sealLinkKey } from "./time.seal";

const KEY = "chx_link_good";
// The package's fake is made for one organisation (its link answers that
// organisation and this application), so each setup builds its own; the
// factory the app holds follows the current one.
let fake: FakeChronixLink = createFakeChronixLink();
const factory: FakeChronixLink["factory"] = (options) => fake.factory(options);
const kit = authApp({ chronix: factory });
beforeAll(() => useChronix(factory));

// chronix's project "p1" is the one every pulsarix project is mapped to.
const CHRONIX_PROJECT = "p1";
// Calls are read from the last reset, since the fake's list only grows.
let seen = 0;
const resetCalls = () => {
  seen = fake.calls.length;
};
const calls = () => fake.calls.slice(seen);
// chronix's clock, set at each fake, moved by `tick`.
let clock = new Date("2026-11-13T10:00:00.000Z");
const tick = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};
const mapProject = (partnerProjectId: string) =>
  fake.map(partnerProjectId, CHRONIX_PROJECT);

// A fresh chronix for one organisation, whose link key is `KEY`, made for
// pulsarix and that organisation unless `options` say otherwise.
function useFake(organisationId: string, options: FakeChronixLinkOptions = {}) {
  const partnerApp = options.partnerApp ?? "pulsarix";
  const partnerOrganisationId = options.partnerOrganisationId ?? organisationId;
  clock = new Date("2026-11-13T10:00:00.000Z");
  fake = createFakeChronixLink({
    now: () => clock,
    organisationName: "Acme Time",
    everyoneIsMember: true,
    ...options,
    partnerApp,
    partnerOrganisationId,
  });
  fake.issueKey(KEY, {
    organisationId: partnerOrganisationId,
    app: partnerApp,
  });
  fake.addProject({ id: CHRONIX_PROJECT, name: "Pulsarix work" });
  resetCalls();
}
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
const ArchiveProject = `mutation($id: ID!) { archiveProject(id: $id) { id archivedAt } }`;
const Unlink = `mutation { unlinkChronix { linked organisationName } }`;
const TimeLink = `{ timeLink { linked organisationName } }`;
const Issue = `query($key: String!) { issue(key: $key) {
  key title estimateHours
  timeSpent { status totalSeconds mySeconds entryCount running } } }`;
const List = `query($projectId: ID!) { issues(projectId: $projectId) {
  nodes { key timeSpent { status totalSeconds } } } }`;
const Start = `mutation($issueId: ID!) { startIssueTimer(issueId: $issueId) { startedAt stoppedSeconds } }`;
const Stop = `mutation($issueId: ID!) { stopIssueTimer(issueId: $issueId) { id durationSeconds billable } }`;
const Mine = `query($key: String!) { issue(key: $key) { timeSpent { status myRunningTimer { startedAt stoppedSeconds } } } }`;
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
async function setup(
  linked = true,
  proveOwner = true,
  chronix: FakeChronixLinkOptions = {},
) {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  useFake(organisation.id, chronix);
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
    // Empty: refused by the input schema. Blank: refused by the guard before
    // anything is sent or sealed.
    expect(codeOf(await asOwner.attempt(Link, { key: "" }))).toBe(
      "validation.errors.invalid-input",
    );
    expect(codeOf(await asOwner.attempt(Link, { key: "   " }))).toBe(
      "time.errors.invalid-key",
    );
    expect(
      (await asOwner.call<{ timeLink: { linked: boolean } }>(TimeLink)).timeLink
        .linked,
    ).toBe(false);
  });

  test("a key made for another application or organisation is refused", async () => {
    const { asOwner, organisation } = await setup(false);
    // chronix answers the link of another application, then of another
    // organisation, for the key it was given.
    for (const other of [
      { partnerApp: "operix" },
      { partnerOrganisationId: "someone-else" },
    ]) {
      useFake(organisation.id, other);
      expect(codeOf(await asOwner.attempt(Link, { key: KEY }))).toBe(
        "time.errors.key-mismatch",
      );
    }
    // A key issued for nobody here is refused by chronix itself.
    useFake(organisation.id);
    expect(codeOf(await asOwner.attempt(Link, { key: "chx_link_other" }))).toBe(
      "time.errors.invalid-key",
    );
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

  // The sealing code before sealerFor, kept here to make the stored values.
  const sealLegacy = (plain: string, organisationId: string) => {
    const [first] = parseSealingKeys(env.TOTP_KEYS, { where: "TOTP_KEYS" });
    const derived = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(first.key, "base64"),
        Buffer.alloc(0),
        "pulsarix:chronix-link-key",
        32,
      ),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(Buffer.from(organisationId));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const sealed = Buffer.concat([body, cipher.getAuthTag()]);
    return `v1.${first.id}.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
  };

  test("a key sealed by the code before sealerFor still opens, for its organisation only", () => {
    const legacy = sealLegacy(KEY, "org-1");
    expect(openLinkKey(legacy, "org-1")).toBe(KEY);
    expect(openLinkKey(legacy, "org-2")).toBeNull();
    expect(openLinkKey(`${legacy}x`, "org-1")).toBeNull();
  });

  test("a value sealed by the old code, kept as a literal, still opens", () => {
    // Made once by develop's sealLinkKey (before sealerFor) with the test key
    // and organisation "org-1".
    const frozen =
      "v1.dev.l8pFHNwyxjSFIjCG.3Umf5y1XVB4AEx26wXMlu8SyCMypS048jDemSmw";
    expect(openLinkKey(frozen, "org-1")).toBe(KEY);
    expect(openLinkKey(frozen, "org-2")).toBeNull();
  });

  test("a legacy value whose body is no longer than the tag does not open", () => {
    for (const bytes of [0, 4, 8, 12, 16]) {
      const body = randomBytes(bytes).toString("base64url");
      const iv = randomBytes(12).toString("base64url");
      expect(openLinkKey(`v1.dev.${iv}.${body}`, "org-1")).toBeNull();
    }
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
    mapProject(project.id);
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
    resetCalls();
    const list = await asOwner.call<{
      issues: { nodes: { timeSpent: { status: string } }[] };
    }>(List, { projectId: project.id });
    expect(list.issues.nodes.map((n) => n.timeSpent.status)).toEqual([
      "AVAILABLE",
      "AVAILABLE",
      "AVAILABLE",
    ]);
    expect(calls().filter((c) => c.op === "totals")).toHaveLength(1);
  });

  test("a chronix outage leaves the issue page working: time unavailable, no error", async () => {
    const { asOwner, project, make } = await setup();
    mapProject(project.id);
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
    mapProject(project.id);
    const issue = await make("Fix the login");
    resetCalls();
    const started = await asMember.call<{
      startIssueTimer: { startedAt: string; stoppedSeconds: number | null };
    }>(Start, { issueId: issue.id });
    expect(started.startIssueTimer.stoppedSeconds).toBeNull();
    const call = calls().find((c) => c.op === "startTimer");
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
    tick(600);
    const next = await asMember.call<{
      startIssueTimer: { stoppedSeconds: number | null };
    }>(Start, { issueId: second.id });
    expect(next.startIssueTimer.stoppedSeconds).toBe(600);
  });

  test("an unverified e-mail cannot start or log, and the time reads FORBIDDEN without a call", async () => {
    // The owner signed up and has not proven the address.
    const { asOwner, project, make } = await setup(true, false);
    mapProject(project.id);
    const issue = await make("Unverified");
    const started = await asOwner.attempt(Start, { issueId: issue.id });
    expect(codeOf(started)).toBe("time.errors.email-unverified");
    const logged = await asOwner.attempt(Log, {
      issueId: issue.id,
      input: { date: "2026-11-02", durationSeconds: 600 },
    });
    expect(codeOf(logged)).toBe("time.errors.email-unverified");
    resetCalls();
    const read = await asOwner.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(read.issue.timeSpent.status).toBe("FORBIDDEN");
    expect(read.issue.timeSpent.totalSeconds).toBeNull();
    expect(calls()).toEqual([]);
  });

  test("an account that is not a member in chronix: FORBIDDEN on reads, forbidden on writes", async () => {
    const { member, asMember, project, make } = await setup(true, true, {
      everyoneIsMember: false,
    });
    mapProject(project.id);
    const issue = await make("Not a member");
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
    fake.addMember(member.email);
    const back = await asMember.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(back.issue.timeSpent.status).toBe("AVAILABLE");
  });

  test("logIssueTime logs on the issue, as the acting member", async () => {
    const { member, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Log me");
    resetCalls();
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
    expect(calls().find((c) => c.op === "logTime")).toMatchObject({
      actor: member.email,
      input: { externalRef: { kind: "issue", id: issue.id } },
    });
  });

  test("the chronix link codes added to contract v1 have their own errors", async () => {
    const { asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("New codes");
    const cases: [string, string][] = [
      ["links.project-archived", "time.errors.project-archived"],
      ["links.project-mapped", "time.errors.project-mapped"],
      ["time.archived", "time.errors.archived"],
      [
        "catalogue.project-not-found",
        "time.errors.catalogue-project-not-found",
      ],
      // Revoked during the request: treated like a refused key.
      ["links.revoked", "time.errors.invalid-key"],
    ];
    for (const [chronixCode, code] of cases) {
      fake.failNext(chronixCode);
      expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
        code,
      );
    }
  });

  test("an archived pulsarix project refuses startIssueTimer and logIssueTime, not stopIssueTimer", async () => {
    const { member, asOwner, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Archived soon");
    await asMember.call(Start, { issueId: issue.id });
    await asOwner.call(ArchiveProject, { id: project.id });
    resetCalls();
    const start = await asMember.attempt(Start, { issueId: issue.id });
    expect(codeOf(start)).toBe("time.errors.pulsarix-project-archived");
    const log = await asMember.attempt(Log, {
      issueId: issue.id,
      input: { date: "2026-11-12", durationSeconds: 600 },
    });
    expect(codeOf(log)).toBe("time.errors.pulsarix-project-archived");
    expect(calls().filter((c) => c.op !== "runningTimer")).toEqual([]);
    // The timer started before the archive can still be stopped.
    const stopped = await asMember.call<{
      stopIssueTimer: { id: string } | null;
    }>(Stop, { issueId: issue.id });
    expect(stopped.stopIssueTimer).not.toBeNull();
    expect(calls().find((c) => c.op === "stopTimer")).toMatchObject({
      actor: member.email,
    });
  });

  test("refusals: not linked, not mapped, locked period, viewer, outage", async () => {
    const { asOwner, asMember, asViewer, project, make } = await setup();
    const issue = await make("Edge cases");
    // chronix has no mapping for the project yet.
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.project-not-mapped",
    );
    mapProject(project.id);
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

describe("stopping the timer and reading the viewer's own", () => {
  test("stopIssueTimer saves the entry as the acting member, then answers null when none runs", async () => {
    const { member, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Stop me");
    await asMember.call(Start, { issueId: issue.id });
    resetCalls();
    tick(300);
    const stopped = await asMember.call<{
      stopIssueTimer: { durationSeconds: number } | null;
    }>(Stop, { issueId: issue.id });
    expect(stopped.stopIssueTimer?.durationSeconds).toBe(300);
    expect(calls().find((c) => c.op === "stopTimer")).toMatchObject({
      key: KEY,
      actor: member.email,
    });
    const again = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: issue.id,
    });
    expect(again.stopIssueTimer).toBeNull();
  });

  test("a viewer cannot stop, and nothing is called", async () => {
    const { asViewer, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Viewer stop");
    resetCalls();
    const result = await asViewer.attempt(Stop, { issueId: issue.id });
    expect(codeOf(result)).toBe("auth.errors.forbidden");
    expect(calls()).toEqual([]);
  });

  test("stopping with no link, an unverified e-mail or an unknown issue is refused", async () => {
    const unlinked = await setup(false);
    const a = await unlinked.make("No link");
    expect(
      codeOf(await unlinked.asMember.attempt(Stop, { issueId: a.id })),
    ).toBe("time.errors.not-linked");
    const unverified = await setup(true, false);
    const b = await unverified.make("Unverified stop");
    expect(
      codeOf(await unverified.asOwner.attempt(Stop, { issueId: b.id })),
    ).toBe("time.errors.email-unverified");
    expect(
      codeOf(
        await unverified.asMember.attempt(Stop, {
          issueId: "000000000000000000000000",
        }),
      ),
    ).toBe("issues.errors.not-found");
  });

  test("chronix failures on stop go through chronixFailure", async () => {
    const { member, asMember, project, make } = await setup(true, true, {
      everyoneIsMember: false,
    });
    mapProject(project.id);
    const issue = await make("Failing stop");
    expect(codeOf(await asMember.attempt(Stop, { issueId: issue.id }))).toBe(
      "time.errors.forbidden",
    );
    fake.addMember(member.email);
    fake.goDown();
    expect(codeOf(await asMember.attempt(Stop, { issueId: issue.id }))).toBe(
      "time.errors.unavailable",
    );
    fake.comeUp();
    fake.revokeKey(KEY);
    expect(codeOf(await asMember.attempt(Stop, { issueId: issue.id }))).toBe(
      "time.errors.invalid-key",
    );
    fake.restoreKey(KEY);
  });

  test("stop leaves a timer that runs on another issue alone", async () => {
    const { asMember, project, make } = await setup();
    mapProject(project.id);
    const a = await make("Stale tab");
    const b = await make("Running");
    await asMember.call(Start, { issueId: b.id });
    resetCalls();
    const stopped = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: a.id,
    });
    expect(stopped.stopIssueTimer).toBeNull();
    expect(calls().some((c) => c.op === "stopTimer")).toBe(false);
    const still = await asMember.call<{
      issue: { timeSpent: { myRunningTimer: unknown } };
    }>(Mine, { key: b.key });
    expect(still.issue.timeSpent.myRunningTimer).not.toBeNull();
  });

  test("stop leaves a timer that has no reference alone", async () => {
    const { member, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Untracked");
    fake.startUntrackedTimer(member.email, project.id);
    resetCalls();
    const stopped = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: issue.id,
    });
    expect(stopped.stopIssueTimer).toBeNull();
    expect(calls().some((c) => c.op === "stopTimer")).toBe(false);
  });

  test("a timer that vanishes between the two chronix calls stops as null", async () => {
    const { asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Race");
    await asMember.call(Start, { issueId: issue.id });
    fake.vanishAfterNextRead();
    resetCalls();
    const stopped = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: issue.id,
    });
    expect(stopped.stopIssueTimer).toBeNull();
    expect(calls().map((c) => c.op)).toEqual(["runningTimer", "stopTimer"]);
  });

  test("an unmapped project is refused on start; stop has no project to map", async () => {
    const { asMember, make } = await setup();
    const issue = await make("Unmapped");
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.project-not-mapped",
    );
    const stopped = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: issue.id,
    });
    expect(stopped.stopIssueTimer).toBeNull();
  });

  test("myRunningTimer shows the timer on its issue only, and null after the stop", async () => {
    const { asMember, asOwner, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Mine");
    const other = await make("Not mine");
    type Mine = {
      issue: {
        timeSpent: {
          status: string;
          myRunningTimer: { startedAt: string } | null;
        };
      };
    };
    expect(
      (await asMember.call<Mine>(Mine, { key: issue.key })).issue.timeSpent
        .myRunningTimer,
    ).toBeNull();
    await asMember.call(Start, { issueId: issue.id });
    const on = await asMember.call<Mine>(Mine, { key: issue.key });
    expect(on.issue.timeSpent.myRunningTimer?.startedAt).toBe(
      "2026-11-13T10:00:00.000Z",
    );
    expect(
      (await asMember.call<Mine>(Mine, { key: other.key })).issue.timeSpent
        .myRunningTimer,
    ).toBeNull();
    // Someone else's timer is not the viewer's.
    expect(
      (await asOwner.call<Mine>(Mine, { key: issue.key })).issue.timeSpent
        .myRunningTimer,
    ).toBeNull();
    await asMember.call(Stop, { issueId: issue.id });
    expect(
      (await asMember.call<Mine>(Mine, { key: issue.key })).issue.timeSpent
        .myRunningTimer,
    ).toBeNull();
  });

  test("myRunningTimer is null for a viewer (no call), without a link, and when chronix is down", async () => {
    const { asMember, asViewer, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Quiet");
    await asMember.call(Start, { issueId: issue.id });
    resetCalls();
    const seen = await asViewer.call<{
      issue: { timeSpent: { myRunningTimer: unknown } };
    }>(Mine, { key: issue.key });
    expect(seen.issue.timeSpent.myRunningTimer).toBeNull();
    expect(calls().some((c) => c.op === "runningTimer")).toBe(false);
    fake.goDown();
    const down = await asMember.call<{
      issue: { timeSpent: { status: string; myRunningTimer: unknown } };
    }>(Mine, { key: issue.key });
    expect(down.issue.timeSpent.myRunningTimer).toBeNull();
    fake.comeUp();
    const unlinked = await setup(false);
    const x = await unlinked.make("Unlinked");
    const none = await unlinked.asMember.call<{
      issue: { timeSpent: { myRunningTimer: unknown } };
    }>(Mine, { key: x.key });
    expect(none.issue.timeSpent.myRunningTimer).toBeNull();
  });

  test("myRunningTimer is null for an unverified e-mail, with no chronix call", async () => {
    const { asOwner, make } = await setup(true, false);
    const issue = await make("Unverified");
    resetCalls();
    const seen = await asOwner.call<{
      issue: { timeSpent: { status: string; myRunningTimer: unknown } };
    }>(Mine, { key: issue.key });
    expect(seen.issue.timeSpent.myRunningTimer).toBeNull();
    expect(calls()).toEqual([]);
  });
});
