import { describe, expect, test } from "bun:test";
import { dirname, relative, resolve } from "node:path";
import {
  assertBoundaries,
  boundaryViolations,
  importsOf,
} from "@alxia/modules";
import { Glob } from "bun";
import { modules } from "../src/modules/registry";

// The module boundaries (plan §4), for every registered module, kernel
// (`src/core/<name>`, surface `index.ts`) and business (`src/modules/<name>`,
// surface `public.ts`): a module reaches another only through its public
// surface, and only when its manifest's `dependsOn` names it. The check is
// `assertBoundaries` of @alxia/modules; a folder that is not a registered
// module (`core/shared`, `core/auth`, ...) is plain infrastructure.
const root = resolve(import.meta.dir, "..");

const config = {
  root,
  roots: [
    { dir: "src/core", surface: "index" },
    { dir: "src/modules", surface: "public" },
  ],
  layers: ["src/core", "src/modules"],
  aliases: { "@/": "src/" },
};

describe("the module boundaries", () => {
  test("src respects the surfaces, dependsOn and the core-below-modules layers", async () => {
    await assertBoundaries(modules, config);
  });

  test("flags a module reaching inside another, or one it does not depend on", () => {
    const modulesRoot = resolve(root, "src/modules");
    const options = { modulesRoot, surface: "public" };
    const inside = {
      [resolve(modulesRoot, "comments/a.ts")]:
        'import "../issues/issues.service";',
    };
    expect(boundaryViolations(inside, modules, options)[0]?.rule).toBe(
      "only via public.ts",
    );
    const undeclared = {
      [resolve(modulesRoot, "projects/a.ts")]: 'import "../comments/public";',
    };
    expect(boundaryViolations(undeclared, modules, options)[0]?.rule).toBe(
      "not in dependsOn",
    );
  });

  test("flags core importing a module, and an @/ alias reaching a kernel module's internals", () => {
    const absolute = {
      roots: config.roots.map((r) => ({ ...r, dir: resolve(root, r.dir) })),
      layers: config.layers.map((l) => resolve(root, l)),
      aliases: { "@/": `${resolve(root, "src")}/` },
      root,
    };
    const at = (path: string) => resolve(root, "src", path);
    const layer = {
      [at("core/auth/a.ts")]: 'import "@/modules/issues/public";',
    };
    expect(boundaryViolations(layer, modules, absolute)[0]?.rule).toContain(
      "may not import layer",
    );
    const inside = {
      [at("modules/comments/a.ts")]: 'import "@/core/members/members.model";',
    };
    expect(boundaryViolations(inside, modules, absolute)[0]?.rule).toBe(
      "only via index.ts",
    );
  });
});

// Kept here: @alxia/modules 0.3.0 checks only files inside a registered module,
// so kernel infrastructure (`core/shared`, `core/auth`...) reaching a kernel
// module's internals is not flagged by `assertBoundaries`. It must go through
// the module's `index.ts`.
export function infrastructureInternals(
  files: Record<string, string>,
  kernelModules: readonly string[],
) {
  const core = resolve(root, "src/core");
  const found: { file: string; imported: string }[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (/\.spec\.ts$/.test(file)) continue;
    const from = relative(core, file).split("/");
    if (from[0] === ".." || from.length < 2) continue;
    if (kernelModules.includes(from[0] as string)) continue;
    for (const specifier of importsOf(text)) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const target = specifier.startsWith("@/")
        ? resolve(root, "src", specifier.slice(2))
        : resolve(dirname(file), specifier);
      const rest = relative(core, target).split("/");
      if (rest[0] === ".." || !kernelModules.includes(rest[0] as string)) {
        continue;
      }
      const surface = rest.slice(1).join("/");
      if (surface !== "" && surface !== "index" && surface !== "index.ts") {
        found.push({ file: relative(root, file), imported: specifier });
      }
    }
  }
  return found;
}

describe("kernel infrastructure", () => {
  const at = (path: string) => resolve(root, "src", path);
  test("flags infrastructure importing a kernel module's internal file", () => {
    const files = {
      [at("core/shared/a.ts")]: 'import "../members/members.model";',
      [at("core/shared/b.ts")]: 'import "../members";',
      [at("core/members/c.ts")]: 'import "./members.model";',
    };
    expect(infrastructureInternals(files, ["members"])).toEqual([
      { file: "src/core/shared/a.ts", imported: "../members/members.model" },
    ]);
  });
  test("src/core infrastructure reaches kernel modules only through index.ts", async () => {
    const files: Record<string, string> = {};
    for await (const path of new Glob("src/core/**/*.ts").scan({ cwd: root })) {
      const file = resolve(root, path);
      files[file] = await Bun.file(file).text();
    }
    const kernel: string[] = [];
    for (const { name } of modules) {
      if (
        await Bun.file(resolve(root, "src/core", name, "module.ts")).exists()
      ) {
        kernel.push(name);
      }
    }
    expect(infrastructureInternals(files, kernel)).toEqual([]);
  });
});

// The wiring that runs the registry's jobs names no module: `src/server.ts`,
// `src/queues.ts` and `src/scripts/**` reach the modules through
// `src/modules/registry` only (specs excepted). The one exception is
// `src/scripts/seed-demo/**`: the demo seed writes its data through the
// modules' `public.ts` services by design.
export function wiringImportsOfModules(files: Record<string, string>) {
  const found: { file: string; imported: string }[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (/\.spec\.ts$/.test(file)) continue;
    const path = relative(resolve(root, "src"), file);
    if (
      path !== "server.ts" &&
      path !== "queues.ts" &&
      !path.startsWith("scripts/")
    ) {
      continue;
    }
    if (path.startsWith("scripts/seed-demo/")) {
      continue;
    }
    for (const specifier of importsOf(text)) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const target = specifier.startsWith("@/")
        ? resolve(root, "src", specifier.slice(2))
        : resolve(dirname(file), specifier);
      const rest = relative(resolve(root, "src/modules"), target);
      if (rest.startsWith("..") || rest === "registry") continue;
      // pulsarix: the server starts the workers through a module's public.ts.
      if (/^[a-z-]+\/public$/.test(rest)) continue;
      found.push({ file: path, imported: specifier });
    }
  }
  return found;
}

describe("the wiring", () => {
  const at = (path: string) => resolve(root, "src", path);
  test("flags a server, queue or script naming a module", () => {
    const files = {
      [at("server.ts")]: 'import "./modules/issues/issues.service";',
      [at("queues.ts")]: 'import "./modules/issues/module";',
      [at("scripts/x.ts")]: 'import "../modules/issues/issues.service";',
      [at("scripts/y.ts")]: 'import "../modules/registry";',
      [at("app.ts")]: 'import "./modules/issues/issues.service";',
    };
    expect(wiringImportsOfModules(files).map((v) => v.file)).toEqual([
      "server.ts",
      "queues.ts",
      "scripts/x.ts",
    ]);
  });
  test("server.ts, queues.ts and src/scripts/** import no module but the registry", async () => {
    const files: Record<string, string> = {};
    for (const pattern of [
      "src/server.ts",
      "src/queues.ts",
      "src/scripts/**/*.ts",
    ]) {
      for await (const path of new Glob(pattern).scan({ cwd: root })) {
        const file = resolve(root, path);
        files[file] = await Bun.file(file).text();
      }
    }
    expect(wiringImportsOfModules(files)).toEqual([]);
  });
});
