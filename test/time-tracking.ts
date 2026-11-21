import {
  createFakeChronixLink,
  type FakeChronixLink,
  type FakeChronixLinkOptions,
} from "@softistx/chronix-react/server/testing";
import { authApp, memberWith, ownerWithOrganisation, proveEmail } from "~/auth";

export const KEY = "chx_link_good";
// The package's fake is made for one organisation (its link answers that
// organisation and this application), so each setup builds its own; the
// factory the app holds follows the current one.
export let fake: FakeChronixLink = createFakeChronixLink();
export const factory: FakeChronixLink["factory"] = (options) =>
  fake.factory(options);
export const kit = authApp({ chronix: factory });

// chronix's project "p1" is the one every pulsarix project is mapped to.
export const CHRONIX_PROJECT = "p1";
// Calls are read from the last reset, since the fake's list only grows.
let seen = 0;
export const resetCalls = () => {
  seen = fake.calls.length;
};
export const calls = () => fake.calls.slice(seen);
// chronix's clock, set at each fake, moved by `tick`.
export let clock = new Date("2026-11-13T10:00:00.000Z");
export const tick = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};
export const mapProject = (partnerProjectId: string) =>
  fake.map(partnerProjectId, CHRONIX_PROJECT);

// A fresh chronix for one organisation, whose link key is `KEY`, made for
// pulsarix and that organisation unless `options` say otherwise.
export function useFake(
  organisationId: string,
  options: FakeChronixLinkOptions = {},
) {
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
export const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id key }
}`;
export const Create = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key title estimateHours }
}`;
export const Update = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { estimateHours }
}`;
export const Link = `mutation($key: String!) { linkChronix(key: $key) { linked organisationName } }`;
export const ArchiveProject = `mutation($id: ID!) { archiveProject(id: $id) { id archivedAt } }`;
export const Unlink = `mutation { unlinkChronix { linked organisationName } }`;
export const TimeLink = `{ timeLink { linked organisationName } }`;
export const Issue = `query($key: String!) { issue(key: $key) {
  key title estimateHours
  timeSpent { status totalSeconds mySeconds entryCount running } } }`;
export const List = `query($projectId: ID!) { issues(projectId: $projectId) {
  nodes { key timeSpent { status totalSeconds } } } }`;
export const Start = `mutation($issueId: ID!) { startIssueTimer(issueId: $issueId) { startedAt stoppedSeconds } }`;
export const Stop = `mutation($issueId: ID!) { stopIssueTimer(issueId: $issueId) { id durationSeconds billable } }`;
export const Mine = `query($key: String!) { issue(key: $key) { timeSpent { status myRunningTimer { startedAt stoppedSeconds } } } }`;
export const Log = `mutation($issueId: ID!, $input: LogIssueTimeInput!) {
  logIssueTime(issueId: $issueId, input: $input) { id date durationSeconds billable }
}`;

export interface TimeSpent {
  status: string;
  totalSeconds: number | null;
  mySeconds: number | null;
  entryCount: number | null;
  running: boolean | null;
}

// An organisation with a project, two issues, an admin (the owner), a member
// and a viewer; linked to chronix unless `linked` is false.
export async function setup(
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
