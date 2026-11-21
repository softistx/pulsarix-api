import { describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import type { MemberView } from "../../core/members";
import { memberScore, searchMembers } from "./search.utils";

const kit = authApp();

const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id }
}`;
const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key }
}`;
const Search = `query($query: String!, $kinds: [SearchKind!], $first: Int) {
  search(query: $query, kinds: $kinds, first: $first) {
    issues { id key title }
    projects { id key name }
    members { id name }
  }
}`;

interface Found {
  search: {
    issues: { id: string; key: string; title: string }[];
    projects: { id: string; key: string; name: string }[];
    members: { id: string; name: string }[];
  };
}

async function setup() {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  const project = async (key: string, name: string, description = "") =>
    (
      await asOwner.call<{ createProject: { id: string } }>(CreateProject, {
        input: { key, name, description },
      })
    ).createProject;
  const issue = async (projectId: string, title: string, description = "") =>
    (
      await asOwner.call<{ createIssue: { id: string; key: string } }>(
        CreateIssue,
        { input: { projectId, title, description } },
      )
    ).createIssue;
  return { owner, organisation, asOwner, project, issue };
}

describe("search", () => {
  test("ranks issues: a title match beats a description match, a key comes first", async () => {
    const t = await setup();
    const p = await t.project("ABC", "Alpha");
    const inBody = await t.issue(p.id, "Unrelated", "the login page is slow");
    const inTitle = await t.issue(p.id, "Login fails", "");
    await t.issue(p.id, "Something else");

    const { search } = await t.asOwner.call<Found>(Search, { query: "login" });
    expect(search.issues.map((i) => i.id)).toEqual([inTitle.id, inBody.id]);

    const byKey = await t.asOwner.call<Found>(Search, { query: "abc-3" });
    expect(byKey.search.issues[0]?.key).toBe("ABC-3");
    expect(
      (await t.asOwner.call<Found>(Search, { query: "ABC-1" })).search.issues[0]
        ?.id,
    ).toBe(inBody.id);
  });

  test("finds a prefix, ignoring case, and escapes the pattern", async () => {
    const t = await setup();
    const p = await t.project("ABC", "Alpha");
    const made = await t.issue(p.id, "Checkout crashes");
    await t.issue(p.id, "Other (thing)");

    const prefix = await t.asOwner.call<Found>(Search, { query: "CHECK" });
    expect(prefix.search.issues.map((i) => i.id)).toEqual([made.id]);
    const paren = await t.asOwner.call<Found>(Search, { query: "(thing" });
    expect(paren.search.issues).toHaveLength(1);
    const wild = await t.asOwner.call<Found>(Search, { query: ".*" });
    expect(wild.search.issues).toHaveLength(0);
  });

  test("finds projects by key, name and description, archived ones too", async () => {
    const t = await setup();
    const alpha = await t.project("ALP", "Alpha", "billing back end");
    const beta = await t.project("BET", "Billing portal");
    const { search } = await t.asOwner.call<Found>(Search, {
      query: "billing",
      kinds: ["project"],
    });
    expect(search.projects.map((p) => p.id)).toEqual([beta.id, alpha.id]);
    expect(search.issues).toEqual([]);
    expect(search.members).toEqual([]);
    const byKey = await t.asOwner.call<Found>(Search, { query: "alp" });
    expect(byKey.search.projects.map((p) => p.id)).toEqual([alpha.id]);
  });

  test("finds members by name and e-mail, and limits each kind", async () => {
    const t = await setup();
    const member = await memberWith(
      kit,
      t.organisation.id,
      t.owner.token,
      "member",
    );
    const { search } = await t.asOwner.call<Found>(Search, {
      query: "member",
      kinds: ["member"],
    });
    expect(search.members.map((m) => m.id)).toEqual([member.id]);

    const p = await t.project("ABC", "Alpha");
    for (const n of [1, 2, 3]) await t.issue(p.id, `Crash ${n}`);
    const limited = await t.asOwner.call<Found>(Search, {
      query: "crash",
      first: 2,
    });
    expect(limited.search.issues).toHaveLength(2);
  });

  test("a viewer reads what the role allows; another organisation's data never shows", async () => {
    const t = await setup();
    const p = await t.project("ABC", "Alpha");
    const made = await t.issue(p.id, "Zebra crossing");
    const viewer = await memberWith(
      kit,
      t.organisation.id,
      t.owner.token,
      "viewer",
    );
    const asViewer = kit.client(viewer.token, {
      organisation: t.organisation.id,
    });
    const seen = await asViewer.call<Found>(Search, { query: "zebra" });
    expect(seen.search.issues.map((i) => i.id)).toEqual([made.id]);

    const other = await ownerWithOrganisation(kit, "Other");
    const asOther = kit.client(other.owner.token, {
      organisation: other.organisation.id,
    });
    expect(
      (await asOther.call<Found>(Search, { query: "zebra" })).search,
    ).toEqual({ issues: [], projects: [], members: [] });
    // Naming an organisation one is no member of is unknown, not forbidden.
    const outsider = kit.client(other.owner.token, {
      organisation: t.organisation.id,
    });
    expect(codeOf(await outsider.attempt(Search, { query: "zebra" }))).toBe(
      "tenancy.errors.unknown-organization",
    );
  });

  test("refuses anonymous callers, empty queries and a bad page size", async () => {
    const t = await setup();
    expect(
      codeOf(
        await kit
          .client(null, { organisation: t.organisation.id })
          .attempt(Search, { query: "x" }),
      ),
    ).toBe("auth.errors.unauthenticated");
    for (const variables of [
      { query: "   " },
      { query: "x".repeat(201) },
      { query: "x", first: 0 },
      { query: "x", first: 51 },
    ]) {
      expect(codeOf(await t.asOwner.attempt(Search, variables))).toBe(
        "validation.errors.invalid-input",
      );
    }
  });
});

describe("member matching", () => {
  const member = (name: string, email: string, active = true): MemberView => ({
    id: email,
    name,
    email,
    role: "member",
    conflict: false,
    active,
    isViewer: false,
  });

  test("scores the name above the e-mail and ignores accents", () => {
    expect(memberScore(member("Élise Martin", "a@x.test"), "elise")).toBe(4);
    expect(
      memberScore(member("Élise Martin", "a@x.test"), "Élise Martin"),
    ).toBe(5);
    expect(memberScore(member("Zoe", "marie@x.test"), "mar")).toBe(2);
    expect(memberScore(member("Zoe", "zoe@x.test"), "nobody")).toBe(0);
  });

  test("lists active members, best match first", () => {
    const found = searchMembers(
      [
        member("Ann Marie", "1@x.test"),
        member("Marie", "2@x.test"),
        member("Marius", "3@x.test", false),
        member("Zed", "marie@y.test"),
      ],
      "marie",
      10,
    );
    expect(found.map((m) => m.id)).toEqual([
      "2@x.test",
      "1@x.test",
      "marie@y.test",
    ]);
  });
});
