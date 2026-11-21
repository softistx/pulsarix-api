import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { goodReport, intakeKit } from "~/intake";
import {
  accept,
  CreateLabel,
  issueOf,
  reportOf,
  send,
  statusesOf,
  Update,
} from "~/public-state";

describe("impact and type", () => {
  test("accept prefills the priority from the impact, with origin client, and adds the type label", async () => {
    const kit = await intakeKit();
    const id = await send(kit, { impact: "blocking", type: "bug" });
    expect(await reportOf(kit, id)).toMatchObject({
      impact: "blocking",
      type: "bug",
    });
    const { acceptClientReport } = await accept(kit, id);
    const issue = await issueOf(kit, acceptClientReport.issueId as string);
    expect(issue).toMatchObject({ priority: "high", priorityOrigin: "client" });
    const { labels } = await statusesOf(kit);
    expect(labels.map((label) => label.name)).toEqual(["Bug"]);
    expect(issue.labelIds).toEqual([labels[0]?.id as string]);

    // The label is made once, then reused.
    const second = await send(kit, { impact: "minor", type: "bug" });
    const again = await accept(kit, second);
    const other = await issueOf(
      kit,
      again.acceptClientReport.issueId as string,
    );
    expect(other).toMatchObject({ priority: "low", priorityOrigin: "client" });
    expect((await statusesOf(kit)).labels).toHaveLength(1);
    expect(other.labelIds).toEqual(issue.labelIds);

    // annoying maps to medium; a team's own label of the name is reused.
    const third = await send(kit, { impact: "annoying", type: "question" });
    const med = await accept(kit, third);
    expect(
      await issueOf(kit, med.acceptClientReport.issueId as string),
    ).toMatchObject({ priority: "medium", priorityOrigin: "client" });
  });

  test("the origin becomes team once a member changes the priority, not when it is sent unchanged", async () => {
    const kit = await intakeKit();
    const id = await send(kit, { impact: "annoying" });
    const { acceptClientReport } = await accept(kit, id);
    const issueId = acceptClientReport.issueId as string;
    await kit.asOwner.call(Update, {
      id: issueId,
      input: { priority: "medium" },
    });
    expect((await issueOf(kit, issueId)).priorityOrigin).toBe("client");
    await kit.asOwner.call(Update, {
      id: issueId,
      input: { priority: "urgent" },
    });
    expect(await issueOf(kit, issueId)).toMatchObject({
      priority: "urgent",
      priorityOrigin: "team",
    });
  });

  test("a report with neither keeps today's behaviour: no priority, no label, origin team", async () => {
    const kit = await intakeKit();
    const id = await send(kit);
    const { acceptClientReport } = await accept(kit, id);
    expect(
      await issueOf(kit, acceptClientReport.issueId as string),
    ).toMatchObject({ priority: "none", priorityOrigin: "team", labelIds: [] });
    expect((await statusesOf(kit)).labels).toHaveLength(0);
  });

  test("the submit input refuses an unknown impact or type", async () => {
    const kit = await intakeKit();
    for (const extra of [{ impact: "huge" }, { type: "rant" }]) {
      const bad = await kit.submit(goodReport(extra));
      expect(bad.response.status).toBe(400);
      expect(bad.body?.errors?.length).toBeGreaterThan(0);
    }
  });
});

describe("type labels", () => {
  test("a team's own lower-case label is reused, and the index refuses a second spelling", async () => {
    const kit = await intakeKit();
    const { createLabel } = await kit.asOwner.call<{
      createLabel: { id: string };
    }>(CreateLabel, {
      input: { projectId: kit.project.id, name: "bug", colour: "#112233" },
    });
    const id = await send(kit, { type: "bug" });
    const { acceptClientReport } = await accept(kit, id);
    const issue = await issueOf(kit, acceptClientReport.issueId as string);
    expect(issue.labelIds).toEqual([createLabel.id]);
    expect((await statusesOf(kit)).labels).toHaveLength(1);
    const taken = await kit.asOwner.attempt(CreateLabel, {
      input: { projectId: kit.project.id, name: "BUG", colour: "#112233" },
    });
    expect(codeOf(taken)).toBe("projects.errors.label-name-taken");
  });
});
