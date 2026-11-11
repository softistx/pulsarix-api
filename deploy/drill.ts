/**
 * The pure parts of the restore drill (restore-drill.ts): which scratch
 * databases the dump is restored into, the guard that keeps them away from the
 * live ones, the comparison with the collections the code defines, and the
 * summary. Kept apart from the script so each can be tested without Docker.
 *
 * Pulsarix has one core database and one database per organisation
 * (`<organisation prefix><id>`), so a drill restores both kinds: the core one as
 * `<scratch>core` and each organisation's as `<scratch>org_<id>`.
 */

/** The scratch prefix of one drill: `drill_<timestamp>_`. */
export function scratchPrefix(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `drill_${stamp}_`;
}

/**
 * Throws unless `prefix` is a safe scratch prefix: well formed, and unable to
 * name a live database (the core one, or any `<organisationPrefix>*` one).
 */
export function assertScratch(
  prefix: string,
  liveCore: string,
  liveOrganisationPrefix: string,
): void {
  if (!/^drill_[0-9TZ]+_$/.test(prefix))
    throw new Error(
      `unexpected scratch prefix ${prefix}: it must look like drill_<timestamp>_`,
    );
  if (`${prefix}core` === liveCore || liveCore.startsWith(prefix))
    throw new Error(
      `refusing to drill into the live core database ${liveCore}: the scratch names must differ`,
    );
  if (
    liveOrganisationPrefix === "" ||
    prefix.startsWith(liveOrganisationPrefix) ||
    liveOrganisationPrefix.startsWith(prefix)
  )
    throw new Error(
      `the organisation prefix '${liveOrganisationPrefix}' overlaps the scratch prefix ${prefix}: a drill could touch a live organisation database`,
    );
}

/** The scratch name of the core database. */
export const scratchCore = (prefix: string): string => `${prefix}core`;

/** Collection name to document count, for one restored database. */
export type Counts = Record<string, number>;

/** What the scratch databases hold: the core one, and each organisation's by id. */
export type Restored = { core: Counts; organisations: Record<string, Counts> };

export type DrillResult = {
  restored: Restored;
  /** Collections the code defines that the restored core database lacks. */
  missingCore: string[];
  /** The same, per organisation id. */
  missingOrganisations: Record<string, string[]>;
  /** Collections found that the code does not define (informational). */
  extra: string[];
  ok: boolean;
};

const missingOf = (expected: readonly string[], counts: Counts): string[] =>
  [...new Set(expected)].filter((c) => !(c in counts)).sort();

/**
 * Compares what was restored with what the code defines. A missing collection
 * in the core database or in any organisation's fails, and so does a dump with
 * no core database at all; an extra one is only reported.
 */
export function compareDatabases(
  expectedCore: readonly string[],
  expectedOrganisation: readonly string[],
  restored: Restored,
): DrillResult {
  const missingCore = missingOf(expectedCore, restored.core);
  const missingOrganisations: Record<string, string[]> = {};
  for (const [id, counts] of Object.entries(restored.organisations)) {
    const missing = missingOf(expectedOrganisation, counts);
    if (missing.length > 0) missingOrganisations[id] = missing;
  }
  const known = new Set([...expectedCore, ...expectedOrganisation]);
  const extra = new Set<string>();
  for (const counts of [
    restored.core,
    ...Object.values(restored.organisations),
  ])
    for (const c of Object.keys(counts))
      if (!known.has(c) && !c.startsWith("system.")) extra.add(c);
  const hasCore = Object.keys(restored.core).length > 0;
  return {
    restored,
    missingCore,
    missingOrganisations,
    extra: [...extra].sort(),
    ok:
      hasCore &&
      missingCore.length === 0 &&
      Object.keys(missingOrganisations).length === 0,
  };
}

function countLines(counts: Counts): string[] {
  const names = Object.keys(counts).sort();
  const width = Math.max(10, ...names.map((n) => n.length));
  return names.map((n) => `    ${n.padEnd(width)}  ${counts[n]}`);
}

/** The lines the script prints: counts per database, then a pass/fail verdict. */
export function summarize(dump: string, result: DrillResult): string {
  const { restored } = result;
  const ids = Object.keys(restored.organisations).sort();
  const lines = [
    `drill: ${dump} restored into scratch databases (1 core, ${ids.length} organisation${ids.length === 1 ? "" : "s"})`,
    "  core",
    ...countLines(restored.core),
  ];
  for (const id of ids)
    lines.push(
      `  organisation ${id}`,
      ...countLines(restored.organisations[id] ?? {}),
    );
  if (Object.keys(restored.core).length === 0)
    lines.push("NO core database in the dump");
  if (result.missingCore.length > 0)
    lines.push(`MISSING in core: ${result.missingCore.join(", ")}`);
  for (const [id, missing] of Object.entries(result.missingOrganisations))
    lines.push(`MISSING in organisation ${id}: ${missing.join(", ")}`);
  if (result.extra.length > 0)
    lines.push(`not defined by the code: ${result.extra.join(", ")}`);
  const failures =
    result.missingCore.length +
    Object.values(result.missingOrganisations).reduce(
      (n, m) => n + m.length,
      0,
    ) +
    (Object.keys(restored.core).length === 0 ? 1 : 0);
  lines.push(
    result.ok
      ? `PASS: the core database and ${ids.length} organisation database${ids.length === 1 ? "" : "s"} hold every collection the code defines`
      : `FAIL: ${failures} problem(s)`,
  );
  return lines.join("\n");
}

/**
 * Parses the `DRILL_DUMP <name>` and `DRILL_COUNTS {...}` lines the container
 * prints; the counts are `{ core: {...}, organisations: { <id>: {...} } }`.
 */
export function parseDrillOutput(output: string): {
  dump: string;
  restored: Restored;
} {
  let dump = "unknown dump";
  let restored: Restored | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("DRILL_DUMP ")) dump = line.slice(11).trim();
    if (line.startsWith("DRILL_COUNTS "))
      restored = JSON.parse(line.slice(13)) as Restored;
  }
  if (!restored) throw new Error("the drill printed no collection counts");
  return {
    dump,
    restored: {
      core: restored.core ?? {},
      organisations: restored.organisations ?? {},
    },
  };
}
