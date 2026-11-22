import { describe, expect, test } from "bun:test";
import { memberWith } from "~/auth";
import { codeOf } from "~/http";
import { Decline } from "~/requests";
import {
  Comment,
  Link,
  Live,
  One,
  Reply,
  setup,
  type Thread,
} from "~/requests-team";
import { subscribe } from "~/sse";
import { eraseReport } from "./retention.service";

describe("a team reply", () => {
  test("reaches only its request, clears the wait and counts as unread", async () => {
    const { w, ada, bob } = await setup();
    // ada's and bob's requests share one issue.
    const issueId = await w.accept(ada);
    await w.kit.asOwner.call(Link, { id: bob, issueId });
    await w.kit.asOwner.call(Comment, {
      issueId,
      input: { body: "Public note", public: true },
    });
    const sent = await w.kit.asOwner.call<{
      replyToClientReport: { clientWaiting: boolean };
    }>(Reply, { id: ada, input: { body: "  We look into it  " } });
    expect(sent.replyToClientReport.clientWaiting).toBe(false);

    const thread = async (id: string) =>
      (await w.kit.asOwner.call<Thread>(One, { id })).clientReport;
    const mine = await thread(ada);
    expect(mine?.thread.map((t) => [t.source, t.body])).toEqual([
      ["REPORTER", "Hi"],
      ["ISSUE_COMMENT", "Public note"],
      ["TEAM_REPLY", "We look into it"],
    ]);
    expect(mine?.thread[2]?.authorId).toBe(w.kit.owner.id);
    const theirs = await thread(bob);
    expect(theirs?.thread.map((t) => t.source)).toEqual(["ISSUE_COMMENT"]);

    const unread = async (sub: string, id: string) =>
      (await w.data(sub, "request", { id }))["request"] as unknown as {
        unread: number;
        thread: { from: string; body: string }[];
      };
    const seen = await unread("ada", ada);
    expect(seen.thread.map((t) => t.body)).toContain("We look into it");
    expect(seen.unread).toBeGreaterThan(0);
    const other = await unread("bob", bob);
    expect(other.thread.map((t) => t.body)).not.toContain("We look into it");
  });

  test("is checked: a body, an unknown or a declined request", async () => {
    const { w, ada, cy } = await setup();
    const reply = (id: string, body: string) =>
      w.kit.asOwner.attempt(Reply, { id, input: { body } });
    expect(codeOf(await reply(ada, "   "))).toBe(
      "validation.errors.invalid-input",
    );
    expect(codeOf(await reply(ada, "x".repeat(5001)))).toBe(
      "validation.errors.invalid-input",
    );
    expect(codeOf(await reply("0".repeat(24), "Hello"))).toBe(
      "intake.errors.not-found",
    );
    await w.kit.asOwner.call(Decline, { id: cy, reason: "No" });
    expect(codeOf(await reply(cy, "Hello"))).toBe(
      "intake.errors.request-declined",
    );
  });

  test("a reply to an erased request is the same 404", async () => {
    const { w, bob } = await setup();
    const report = await w.mongo.db.clientReports.findFirst({
      title: "By bob",
    });
    await eraseReport(w.mongo, report as NonNullable<typeof report>);
    expect(
      codeOf(
        await w.kit.asOwner.attempt(Reply, {
          id: bob,
          input: { body: "Hello" },
        }),
      ),
    ).toBe("intake.errors.not-found");
    expect(codeOf(await w.kit.asOwner.attempt(One, { id: bob }))).toBe(
      "intake.errors.not-found",
    );
  });

  test("an unknown request is the same 404 on a read", async () => {
    const { w } = await setup();
    expect(
      codeOf(await w.kit.asOwner.attempt(One, { id: "0".repeat(24) })),
    ).toBe("intake.errors.not-found");
  });
});

describe("the live requests topic", () => {
  test("tells those who triage of a reply, and refuses the others", async () => {
    const { w, ada } = await setup();
    const open = (token: string) =>
      subscribe<{
        requestsChanged: { reportId: string; kind: string; at: string };
      }>(w.kit.kit, token, { organisation: w.kit.organisation.id }, Live);
    const team = await open(w.kit.owner.token);
    const viewer = await memberWith(
      w.kit.kit,
      w.kit.organisation.id,
      w.kit.owner.token,
      "viewer",
    );
    const refused = await open(viewer.token);
    await Bun.sleep(100);

    await w.kit.asOwner.call(Reply, { id: ada, input: { body: "On it" } });
    const event = (await team.next())?.data?.requestsChanged;
    expect(event).toMatchObject({ reportId: ada, kind: "STATE" });

    const nothing = await refused.next(300);
    expect(nothing?.data?.requestsChanged ?? null).toBeNull();
    await team.close();
    await refused.close();
  });
});
