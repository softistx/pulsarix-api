import type { AppTenancy } from "./db";

/**
 * Brings every organisation database to the migrations list
 * (src/core/migrations) before the API listens: `migrateTenants` syncs, then
 * migrates each one, under the library's lock (a second instance booting at the
 * same time waits or fails, never runs it twice), and records the ids applied.
 * Every organisation is visited and a failure of one does not stop the others;
 * any failure is logged with its organisation and ends the process (exit 1), so
 * a deploy's healthcheck fails rather than serving data a migration left half
 * done. A new organisation is migrated by `provision`, not here. Idempotent.
 */
export async function migrateAtBoot(
  tenancy: Pick<AppTenancy, "migrateTenants">,
  exit: (code: number) => never = process.exit,
): Promise<void> {
  let results: Awaited<ReturnType<AppTenancy["migrateTenants"]>>;
  try {
    results = await tenancy.migrateTenants({ kind: "apply", dryRun: false });
  } catch (error) {
    console.error("pulsarix-api: migrations failed, not starting:", error);
    return exit(1);
  }
  const failed = results.filter((result) => !result.ok);
  for (const result of failed) {
    console.error(
      `pulsarix-api: migrations failed on ${result.database}, not starting:`,
      result.ok ? undefined : result.error,
    );
  }
  if (failed.length > 0) return exit(1);
  const applied = results.flatMap((r) => (r.ok ? r.outcome.ids : []));
  console.log(
    `pulsarix-api: ${results.length} organisation database(s) migrated (${applied.length} applied)`,
  );
}
