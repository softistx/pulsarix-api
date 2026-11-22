import { defineMigration } from "@softistx/mongo/migrations";

// Plan §20.3. Issues stored before the types have none (read as a task,
// `typeOf`); this writes it. Precedence: a parent makes a Sub-task, then a label
// named "bug" (any case) a Bug, else a Task. Only issues with no type are
// touched, so a second run, or an issue typed since, is left alone. Labels and
// links are kept (a link that breaks the parent rules stays: the rules apply to
// later changes) and no stamp moves. Frozen once merged: a fix is a new
// migration.
export const issueTypes = defineMigration({
  id: "2026-11-21-issue-types",
  async up({ db, session }) {
    // Written past the validator: the documents are of the previous shape.
    const inSession = session === undefined ? {} : { session };
    const options = { ...inSession, bypassDocumentValidation: true };
    const issues = db.collection("issues");
    const untyped = { type: null };
    await issues.updateMany(
      { ...untyped, parentId: { $ne: null } },
      { $set: { type: "subTask" } },
      options,
    );
    const bugs = await db
      .collection("labels")
      .find(
        { name: { $regex: /^bug$/i } },
        { ...inSession, projection: { _id: 1 } },
      )
      .toArray();
    if (bugs.length > 0) {
      await issues.updateMany(
        { ...untyped, labelIds: { $in: bugs.map((label) => label._id) } },
        { $set: { type: "bug" } },
        options,
      );
    }
    await issues.updateMany(untyped, { $set: { type: "task" } }, options);
  },
  // Nothing to undo: a stored type is read the same as the missing one for the
  // issues this typed as tasks, and the others were typed by their authors
  // since. Clearing them all would lose those.
  async down() {},
});
