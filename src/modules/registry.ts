import { type Module, resolveModules } from "@alxia/modules";
import { system } from "../core/system/module";

// THE list of modules: adding one is one line here. Dependency order is
// computed (`resolveModules`), not written.
const registered = [system] as const;

export const modules: readonly Module[] = resolveModules(registered);
