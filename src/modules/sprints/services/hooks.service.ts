import { registerActiveSprint, registerSprintLeft } from "../../issues/public";
import { registerSprintsOffCheck } from "../../projects/public";
import { activeSprint } from "../sprints.errors";
import type { SprintsMongo } from "../sprints.types";
import { SprintSnapshots } from "./snapshots.service";

// What the sprints module plugs into the modules it depends on (they cannot
// import it): called once, from module.ts.
export function registerSprintHooks(): void {
  // The issue list's `activeSprint` filter asks which sprint runs.
  registerActiveSprint(async (mongo, projectId) => {
    const active = await (
      mongo as unknown as SprintsMongo
    ).db.sprints.findFirst({ projectId, state: "active" });
    return active?._id ?? null;
  });

  // Sprints cannot be turned off while one is active.
  registerSprintsOffCheck(async (mongo, projectId) => {
    const running = await (mongo as unknown as SprintsMongo).db.sprints.exists({
      projectId,
      state: "active",
    });
    if (running) throw activeSprint();
  });

  // An issue that an edit takes out of an active sprint changes its scope.
  registerSprintLeft(async (mongo, sprintId, timeZone, now) => {
    const db = mongo as unknown as SprintsMongo;
    const sprint = await db.db.sprints.findById(sprintId);
    if (sprint?.state !== "active") return;
    await new SprintSnapshots(db, timeZone).take(sprint, "scope", now);
  });
}
