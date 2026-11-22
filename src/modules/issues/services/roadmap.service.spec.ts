import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { List, type Listing, withProject } from "~/issues";
import { RoadmapService } from "./roadmap.service";

interface Row {
  epic: { title: string } | null;
  done: boolean;
  start: string | null;
  end: string | null;
  startDerived: boolean;
  endDerived: boolean;
  progress: { done: number; total: number; points: number; pointsDone: number };
}
const Roadmap = `query($projectId: ID!) {
  roadmap(projectId: $projectId) {
    epics { ...Row }
    undated { ...Row }
    noEpic { ...Row }
  }
}
fragment Row on RoadmapRow {
  epic { title } done start end startDerived endDerived
  progress { done total points pointsDone }
}`;

async function setup() {
  const t = await withProject();
  const roadmap = async () =>
    (
      await t.asOwner.call<{
        roadmap: { epics: Row[]; undated: Row[]; noEpic: Row };
      }>(Roadmap, { projectId: t.project.id })
    ).roadmap;
  const epic = (title: string, extra: Record<string, unknown> = {}) =>
    t.make(title, { type: "epic", ...extra });
  return { ...t, roadmap, epic };
}

describe("roadmap", () => {
  test("an Epic's own dates win over its children's", async () => {
    const { roadmap, epic, make } = await setup();
    const e = await epic("Own", {
      startDate: "2026-03-01T00:00:00.000Z",
      dueDate: "2026-03-31T00:00:00.000Z",
    });
    await make("Child", {
      type: "story",
      parentId: e.id,
      startDate: "2026-01-01T00:00:00.000Z",
      dueDate: "2026-06-30T00:00:00.000Z",
    });
    const { epics, undated } = await roadmap();
    expect(undated).toEqual([]);
    expect(epics).toHaveLength(1);
    expect(epics[0]).toMatchObject({
      epic: { title: "Own" },
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-31T00:00:00.000Z",
      startDerived: false,
      endDerived: false,
    });
  });

  test("without its own dates it takes the earliest child start or due date and the latest due date", async () => {
    const { roadmap, epic, make } = await setup();
    const e = await epic("Derived");
    await make("A", {
      type: "story",
      parentId: e.id,
      dueDate: "2026-02-10T00:00:00.000Z",
    });
    await make("B", {
      type: "task",
      parentId: e.id,
      startDate: "2026-02-03T00:00:00.000Z",
      dueDate: "2026-02-20T00:00:00.000Z",
    });
    const [row] = (await roadmap()).epics;
    expect(row).toMatchObject({
      start: "2026-02-03T00:00:00.000Z",
      end: "2026-02-20T00:00:00.000Z",
      startDerived: true,
      endDerived: true,
    });
  });

  test("an Epic with no date anywhere is listed apart", async () => {
    const { roadmap, epic, make } = await setup();
    const e = await epic("Nowhere");
    await make("Child", { type: "story", parentId: e.id });
    await epic("Dated", { dueDate: "2026-05-01T00:00:00.000Z" });
    const r = await roadmap();
    expect(r.undated.map((row) => row.epic?.title)).toEqual(["Nowhere"]);
    expect(r.undated[0]).toMatchObject({ start: null, end: null });
    expect(r.epics.map((row) => row.epic?.title)).toEqual(["Dated"]);
  });

  test("progress counts issues and points; done Epics are flagged, cancelled ones left out", async () => {
    const { roadmap, epic, make, done, project } = await setup();
    const cancelled = project.statuses.find((s) => s.category === "cancelled");
    const e = await epic("Counted", { dueDate: "2026-05-01T00:00:00.000Z" });
    await make("Done", {
      type: "story",
      parentId: e.id,
      points: 5,
      statusId: done,
    });
    await make("Open", { type: "task", parentId: e.id, points: 3 });
    expect(cancelled).toBeDefined();
    if (cancelled) {
      await make("Dropped", {
        type: "task",
        parentId: e.id,
        points: 8,
        statusId: cancelled.id,
      });
      await epic("Gone", {
        statusId: cancelled.id,
        dueDate: "2026-02-01T00:00:00.000Z",
      });
    }
    await epic("Shipped", {
      statusId: done,
      dueDate: "2026-01-01T00:00:00.000Z",
    });
    const { epics, undated } = await roadmap();
    expect(undated).toEqual([]);
    expect(epics.map((row) => row.epic?.title).sort()).toEqual([
      "Counted",
      "Shipped",
    ]);
    const counted = epics.find((row) => row.epic?.title === "Counted");
    expect(counted?.done).toBe(false);
    expect(counted?.progress).toEqual({
      done: 1,
      total: 2,
      points: 8,
      pointsDone: 5,
    });
    expect(epics.find((row) => row.epic?.title === "Shipped")?.done).toBe(true);
  });

  test("the No Epic row holds the Story, Task and Bug issues with no Epic", async () => {
    const { roadmap, epic, make, done, asOwner, project } = await setup();
    const e = await epic("Planned");
    await make("In epic", { type: "story", parentId: e.id });
    await make("Loose story", {
      type: "story",
      points: 2,
      dueDate: "2026-04-10T00:00:00.000Z",
    });
    await make("Loose task", {
      points: 3,
      statusId: done,
      startDate: "2026-04-02T00:00:00.000Z",
    });
    await make("Loose bug", {
      type: "bug",
      dueDate: "2026-04-20T00:00:00.000Z",
    });
    const { noEpic } = await roadmap();
    expect(noEpic.epic).toBeNull();
    expect(noEpic).toMatchObject({
      done: false,
      start: "2026-04-02T00:00:00.000Z",
      end: "2026-04-20T00:00:00.000Z",
      startDerived: true,
      endDerived: true,
      progress: { done: 1, total: 3, points: 5, pointsDone: 3 },
    });
    const withEpics = await asOwner.call<Listing>(List, {
      projectId: project.id,
      filter: { noEpic: true, types: ["epic", "bug"] },
    });
    expect(withEpics.issues.nodes.map((n) => n.title)).toEqual(["Loose bug"]);
    const listed = await asOwner.call<Listing>(List, {
      projectId: project.id,
      filter: { noEpic: true },
    });
    expect(listed.issues.nodes.map((n) => n.title).sort()).toEqual([
      "Loose bug",
      "Loose story",
      "Loose task",
    ]);
  });

  test("a malformed project id is a 400", async () => {
    const { asOwner } = await setup();
    expect(codeOf(await asOwner.attempt(Roadmap, { projectId: "nope" }))).toBe(
      "validation.errors.invalid-input",
    );
  });
});

describe("roadmap reads", () => {
  // A stub of the two collections that counts every read.
  const stubbed = (epics: number) => {
    const reads: string[] = [];
    const issues = Array.from({ length: epics }, (_, n) => ({
      id: n.toString(16).padStart(24, "0"),
      statusId: { toHexString: () => "s" },
      parentId: null,
    }));
    const mongo = {
      db: {
        issues: {
          findMany: async () => {
            reads.push("issues");
            return issues;
          },
        },
        statuses: {
          findMany: async () => {
            reads.push("statuses");
            return [];
          },
        },
      },
    };
    return { mongo, reads };
  };

  test("the number of reads does not grow with the number of Epics", async () => {
    const few = stubbed(1);
    const many = stubbed(40);
    const valid = "0123456789abcdef01234567";
    await new RoadmapService(few.mongo as never).of(valid);
    await new RoadmapService(many.mongo as never).of(valid);
    expect(many.reads).toEqual(few.reads);
    expect(many.reads).toHaveLength(4);
  });
});
