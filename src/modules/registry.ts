import { type Module, resolveModules } from "@alxia/modules";
import { access } from "../core/access/module";
import { accountsModule } from "../core/accounts/module";
import { invitationsModule } from "../core/invitations/module";
import { membersModule } from "../core/members/module";
import { organisationsModule } from "../core/organisations/module";
import { system } from "../core/system/module";

// THE list of modules: adding one is one line here. Dependency order is
// computed (`resolveModules`), not written.
const registered = [
  system,
  access,
  accountsModule,
  organisationsModule,
  membersModule,
  invitationsModule,
] as const;

export const modules: readonly Module[] = resolveModules(registered);

// The registered manifests with their own types, for the typed handles of the
// databases (`CollectionsOf`, `ModuleHandle`; src/config/db.ts).
declare module "@alxia/modules" {
  interface Register {
    modules: typeof registered;
  }
}
