import { describe, expect, test } from "bun:test";
import {
  AddComment,
  Board,
  DeleteIssue,
  type Event,
  type IssueEvent,
  IssueLive,
  journal,
  MoveIssue,
  setup,
  UpdateIssue,
} from "~/activity";
import { authApp } from "~/auth";

const kit = authApp();

describe("live events", () => {
  test("two clients see an issue move live", async () => {
    const { asOwner, project, issue, status, member, live, owner } =
      await setup(kit);
    const created = await issue("Moving");
    const ada = await live(owner.token)<Event>(Board, {
      projectId: project.id,
    });
    const bob = await live(member.token)<Event>(Board, {
      projectId: project.id,
    });
    expect(ada.status).toBe(200);
    // The stream is open once the first event can be heard: give Redis-less
    // channels a beat to register both readers.
    await Bun.sleep(100);

    const done = status("done");
    const { moveIssue } = await asOwner.call<{
      moveIssue: { statusId: string; rank: string };
    }>(MoveIssue, { id: created.id, statusId: done });

    for (const client of [ada, bob]) {
      const event = (await client.next())?.data?.projectBoard;
      expect(event).toMatchObject({
        verb: "moved",
        issueId: created.id,
        issueKey: "ABC-1",
        statusId: done,
        rank: moveIssue.rank,
      });
      expect(event?.fields).toContain("statusId");
    }
    // The event names the row the journal wrote.
    const [latest] = (await journal(asOwner, { projectId: project.id })).nodes;
    expect(latest?.verb).toBe("moved");
    await ada.close();
    await bob.close();
  });

  test("the board hears creates, updates and deletes, not comments; the issue hears its comments", async () => {
    const { asOwner, project, issue, owner, live } = await setup(kit);
    const board = await live(owner.token)<Event>(Board, {
      projectId: project.id,
    });
    await Bun.sleep(100);
    const created = await issue("Live");
    const one = await live(owner.token)<IssueEvent>(IssueLive, {
      issueId: created.id,
    });
    await Bun.sleep(100);
    await asOwner.call(UpdateIssue, {
      id: created.id,
      input: { title: "Live too" },
    });
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: "Hi" },
    });
    await asOwner.call(DeleteIssue, { id: created.id });

    expect((await board.next())?.data?.projectBoard.verb).toBe("created");
    expect((await board.next())?.data?.projectBoard.verb).toBe("updated");
    expect((await board.next())?.data?.projectBoard.verb).toBe("deleted");
    expect(await board.quiet()).toBe(true);

    expect((await one.next())?.data?.issueChanged.verb).toBe("updated");
    expect((await one.next())?.data?.issueChanged.verb).toBe("commented");
    expect((await one.next())?.data?.issueChanged.verb).toBe("deleted");
    await board.close();
    await one.close();
  });

  test("a refused write publishes nothing", async () => {
    const { asOwner, project, issue, status, owner, live } = await setup(kit);
    const created = await issue();
    const board = await live(owner.token)<Event>(Board, {
      projectId: project.id,
    });
    await Bun.sleep(100);
    const refused = await asOwner.attempt(MoveIssue, {
      id: created.id,
      statusId: status("done"),
      afterId: created.id,
    });
    expect(refused.errors).toBeDefined();
    expect(await board.quiet()).toBe(true);
    await board.close();
  });
});
