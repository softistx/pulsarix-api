import { type Module, resolveModules } from "@softistx/alxia-modules";
import type { Resolvers } from "@softistx/graxia";
import { access } from "../core/access/module";
import { accountsModule } from "../core/accounts/module";
import { invitationsModule } from "../core/invitations/module";
import { membersModule } from "../core/members/module";
import { organisationsModule } from "../core/organisations/module";
import { system } from "../core/system/module";
import type { Context } from "../http/context";
import { activityModule } from "./activity/module";
import { attachmentsModule } from "./attachments/module";
import { commentsModule } from "./comments/module";
import { dashboardModule } from "./dashboard/module";
import { intakeModule } from "./intake/module";
import { issuesModule } from "./issues/module";
import { notificationsModule } from "./notifications/module";
import { projectsModule } from "./projects/module";
import { searchModule } from "./search/module";
import { sprintsModule } from "./sprints/module";
import { timeModule } from "./time/module";

// THE list of modules: adding one is one line here. Dependency order is
// computed (`resolveModules`), not written.
const registered = [
  system,
  access,
  accountsModule,
  organisationsModule,
  membersModule,
  invitationsModule,
  projectsModule,
  issuesModule,
  commentsModule,
  attachmentsModule,
  activityModule,
  notificationsModule,
  searchModule,
  dashboardModule,
  intakeModule,
  timeModule,
  sprintsModule,
] as const;

export const modules: readonly Module[] = resolveModules(registered);

// The registered manifests with their own types, for the typed handles of the
// databases (`CollectionsOf`, `ModuleHandle`; src/config/db.ts).
declare module "@softistx/alxia-modules" {
  interface Register {
    modules: typeof registered;
    resolvers: Resolvers<Context>;
  }
}
