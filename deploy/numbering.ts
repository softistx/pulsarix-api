/**
 * The post-restore issue-number check, run by the restore drill.
 *
 * An issue's `number` comes from `issueCounters` (`{ projectId, last }`), a
 * collection apart from `issues` (src/modules/issues/issues.service.ts). A
 * counter BEHIND the highest number of its project's issues (or missing) makes
 * the next issue of that project collide on the unique `(projectId, number)`
 * index, so it is an error; a counter AHEAD is a skipped number, which is fine.
 * The pure parts are here so they run without Docker; `NUMBERING_EXPORT` is the
 * mongosh program that reads the data out. Modelled on operix-api's check.
 */

/** What `NUMBERING_EXPORT` prints for one organisation database. */
export type OrganisationExport = {
  counters: { _id: string; last: number }[];
  /** The highest issue number per project id. */
  issueMax: { _id: string; max: number }[];
};

export type NumberingProblem = {
  organisation: string;
  projectId: string;
  /** The counter's `last`, 0 when there is no counter. */
  counter: number;
  /** The highest number found among the project's issues. */
  highest: number;
};

export type NumberingResult = {
  /** Projects with issues whose counter was compared. */
  checked: number;
  /** Counters ahead of their issues: fine, a skipped number. */
  ahead: number;
  /** Counters behind their issues, or missing: the next issue would collide. */
  problems: NumberingProblem[];
  ok: boolean;
};

/** Compares, per organisation and project, the counter with the issues' highest number. */
export function checkNumbering(
  organisations: Record<string, OrganisationExport>,
): NumberingResult {
  const problems: NumberingProblem[] = [];
  let checked = 0;
  let ahead = 0;
  for (const [organisation, data] of Object.entries(organisations)) {
    const counters = new Map(data.counters.map((c) => [c._id, c.last]));
    for (const { _id: projectId, max } of data.issueMax) {
      const counter = counters.get(projectId) ?? 0;
      checked += 1;
      if (counter < max)
        problems.push({ organisation, projectId, counter, highest: max });
      else if (counter > max) ahead += 1;
    }
  }
  return { checked, ahead, problems, ok: problems.length === 0 };
}

/** The lines the drill prints for a result. */
export function summarizeNumbering(result: NumberingResult): string {
  const lines = result.problems.map(
    (p) =>
      `NUMBERING BEHIND in organisation ${p.organisation}: project ${p.projectId} counter ${p.counter}, highest issue number ${p.highest}`,
  );
  lines.push(
    result.ok
      ? `numbering: PASS, ${result.checked} project counter(s) checked, none behind its issues (${result.ahead} ahead, which is fine)`
      : `numbering: FAIL, ${result.problems.length} counter(s) behind their issues: the next issue of those projects would collide on its number`,
  );
  return lines.join("\n");
}

/** Parses the `NUMBERING_DATA {...}` line the container prints. */
export function parseNumberingOutput(
  output: string,
): Record<string, OrganisationExport> {
  for (const line of output.split("\n"))
    if (line.startsWith("NUMBERING_DATA "))
      return JSON.parse(line.slice(15)) as Record<string, OrganisationExport>;
  throw new Error("the numbering export printed no data");
}

/**
 * A mongosh program (run with `mongosh --nodb --quiet --eval`). Environment:
 * RESTORE_URI (root, replica set), NUMBERING_PREFIX (an organisation database
 * is `<prefix><id>`; for the drill, the scratch prefix plus `org_`). Prints one
 * `NUMBERING_DATA` line: `{ <id>: OrganisationExport }`.
 */
export const NUMBERING_EXPORT = `
const c = connect(process.env.RESTORE_URI);
const prefix = process.env.NUMBERING_PREFIX;
const out = {};
for (const { name } of c.adminCommand({ listDatabases: 1, nameOnly: true }).databases) {
  if (!name.startsWith(prefix)) continue;
  const db = c.getSiblingDB(name);
  out[name.slice(prefix.length)] = {
    counters: db.getCollection("issueCounters").find({}, { last: 1, projectId: 1 }).toArray().map((x) => ({ _id: String(x.projectId), last: x.last || 0 })),
    issueMax: db.getCollection("issues").aggregate([{ $group: { _id: "$projectId", max: { $max: "$number" } } }]).toArray().map((x) => ({ _id: String(x._id), max: x.max || 0 })),
  };
}
print("NUMBERING_DATA " + JSON.stringify(out));
`;
