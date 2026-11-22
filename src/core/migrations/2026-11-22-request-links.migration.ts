import { defineMigration } from "@softistx/mongo/migrations";

// The account that stamps a link no account made (see core/shared/actors).
const SYSTEM = "00000000-0000-7000-8000-000000000000";

// Plan §20.4. A request kept its one issue in `clientReports.issueId`; the
// many-to-many links live in `clientReportLinks`. One link is written per
// report that has an issue: `linkedAt` is when it was linked (else decided,
// else created) and `linkedBy` who decided it. The pair is upserted, so a
// second run, or a link made since, is left alone. `issueId` stays on the
// report as the first link (deprecated mirror). Frozen once merged: a fix is a
// new migration.
export const requestLinks = defineMigration({
  id: "2026-11-22-request-links",
  async up({ db, session }) {
    const inSession = session === undefined ? {} : { session };
    const reports = await db
      .collection("clientReports")
      .find({ issueId: { $ne: null } }, inSession)
      .toArray();
    const links = db.collection("clientReportLinks");
    for (const report of reports) {
      const at =
        report["linkedAt"] ?? report["decidedAt"] ?? report["createdAt"];
      const by = report["decidedBy"] ?? SYSTEM;
      await links.updateOne(
        { reportId: report._id, issueId: report["issueId"] },
        {
          $setOnInsert: {
            linkedAt: at,
            linkedBy: by,
            createdAt: at,
            updatedAt: at,
            createdBy: by,
            updatedBy: by,
          },
        },
        { ...inSession, upsert: true, bypassDocumentValidation: true },
      );
    }
  },
  // Nothing to undo: the reports still carry their first issue, and the links
  // made since the migration would be lost by clearing the collection.
  async down() {},
});
