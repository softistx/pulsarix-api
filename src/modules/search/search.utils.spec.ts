import { describe, expect, test } from "bun:test";
import type { MemberView } from "../../core/members";
import { issueKeyOf, memberScore, searchMembers } from "./search.utils";

describe("issueKeyOf", () => {
  test("an issue key is upper-cased, anything else is null", () => {
    expect(issueKeyOf("px-12")).toBe("PX-12");
    expect(issueKeyOf("fix the bug")).toBeNull();
    expect(issueKeyOf("px-")).toBeNull();
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
