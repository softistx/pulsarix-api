import { mkdir, readdir, rm } from "node:fs/promises";
import {
  buildSchema,
  lexicographicSortSchema,
  parse,
  print,
  printSchema,
} from "graphql";
import { persistedOperations } from "@/modules/intake/intake.public.operations";
import { publicTypeDefs } from "@/modules/intake/intake.public.typedefs";

// Writes the schema of /public/graphql to schema.public.graphql and each of its
// persisted operations to operations/public/<id>.graphql, at the repository
// root: the committed contract pulsarix-widget generates its types from
// (type-only codegen, read from a sibling checkout). The schema is sorted and
// each document is printed by graphql-js from its parsed form, so the files do
// not depend on the formatting of the source, and the operations are written
// in id order. With --check, writes nothing and exits 1 when a file is stale,
// missing or left over, which `bun run verify` runs.
const root = `${import.meta.dir}/..`;
const schemaPath = `${root}/schema.public.graphql`;
const operationsDir = `${root}/operations/public`;

const files = new Map<string, string>();
files.set(
  schemaPath,
  `${printSchema(lexicographicSortSchema(buildSchema(publicTypeDefs)))}\n`,
);
for (const id of Object.keys(persistedOperations).sort()) {
  const source = persistedOperations[id as keyof typeof persistedOperations];
  files.set(`${operationsDir}/${id}.graphql`, `${print(parse(source))}\n`);
}

async function existing(): Promise<string[]> {
  try {
    return (await readdir(operationsDir)).filter((n) => n.endsWith(".graphql"));
  } catch {
    return [];
  }
}

const stale: string[] = [];
for (const [path, printed] of files) {
  const file = Bun.file(path);
  const current = (await file.exists()) ? await file.text() : "";
  if (current !== printed) stale.push(path);
}
const wanted = new Set([...files.keys()].map((p) => p.split("/").pop()));
const extra = (await existing()).filter((n) => !wanted.has(n));

if (process.argv.includes("--check")) {
  if (stale.length > 0 || extra.length > 0) {
    console.error(
      "schema.public.graphql or operations/public is stale: run `bun run schema:print:public` and commit it",
    );
    process.exit(1);
  }
} else {
  await mkdir(operationsDir, { recursive: true });
  for (const name of extra) await rm(`${operationsDir}/${name}`);
  for (const [path, printed] of files) await Bun.write(path, printed);
}
