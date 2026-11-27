import { defineMigration } from "@softistx/mongo/migrations";

// Sprints (plan §20.6). Issues stored before sprints have no `planRank`, the
// place among the issues of a sprint or of the backlog; this gives each its
// board `rank`, which is a valid fractional rank. Columns share ranks, so
// ties are broken by the issue number when listing, and a new issue goes
// after the last backlog plan rank. Only issues with no plan rank are touched, so a second run, or
// an issue planned since, is left alone. `sprintId` needs nothing: a missing
// one is read as null (the backlog). Frozen once merged: a fix is a new
// migration.
export const planRank = defineMigration({
  id: "2026-11-26-plan-rank",
  async up({ db, session }) {
    // Written past the validator: the documents are of the previous shape.
    const options = {
      ...(session === undefined ? {} : { session }),
      bypassDocumentValidation: true,
    };
    await db
      .collection("issues")
      .updateMany(
        { planRank: { $exists: false } },
        [{ $set: { planRank: "$rank" } }],
        options,
      );
  },
  // Nothing to undo: a plan rank is read the same as the rank it copied.
  async down() {},
});
