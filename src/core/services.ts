import type { AppTenancy, CoreMongo } from "../config/db";
import { localeOfRequest } from "../i18n/locale";
import type { Role } from "./access";
import { SignInService, ViewerService } from "./accounts";
import type { Auth } from "./auth";
import { requireFresh } from "./auth/fresh";
import type { Viewer } from "./auth/viewer";
import { AcceptanceService, InvitationsService } from "./invitations";
import { MembersService } from "./members";
import { OrganisationsService } from "./organisations";
import type { KernelLimits } from "./shared/limits";
import type { Organisation } from "./tenancy";

// What a request builds anew, so none is shared between requests: the kernel's
// services over janus and the core database. A business module builds its own
// service in its resolvers from the scope a guard returns.
export function services(deps: {
  auth: Auth;
  core: CoreMongo;
  tenancy: Pick<AppTenancy, "provision">;
  request: Request;
  // The rate limits (none without Redis).
  limits?: KernelLimits | undefined;
}) {
  return {
    // The per-address limits of the anonymous mutations (none without Redis).
    limits: deps.limits,
    signIn: new SignInService(deps.auth, deps.request, localeOfRequest()),
    // The signed-in account on itself (a guard hands it the viewer).
    viewer: (viewer: Viewer) =>
      new ViewerService(deps.auth, viewer, deps.request, localeOfRequest()),
    // Refuses a session whose last proof of identity is not recent (a role
    // change, a removal).
    requireFresh: (viewer: Viewer) => requireFresh(viewer, deps.auth.clock),
    organisations: new OrganisationsService(
      deps.core,
      deps.tenancy,
      deps.auth.membership,
      deps.limits,
    ),
    // The role an account holds in an organisation, null for a non-member (a
    // business module checks that an account it is given belongs there).
    roleOf: (organisationId: string, accountId: string) =>
      deps.auth.membership.roleOf(organisationId, accountId),
    // Anonymous, from a mail's link.
    acceptance: new AcceptanceService(deps.core, deps.auth, localeOfRequest()),
    // Built once a guard resolved the organisation (src/core/access/guards.ts),
    // for the member who manages: their writes are stamped by `viewerId`.
    members: (organisation: Organisation, viewerId: string) =>
      new MembersService(
        deps.core.as(viewerId),
        deps.auth,
        organisation,
        viewerId,
      ),
    invitations: (
      organisation: Organisation,
      inviterRole: Role,
      viewerId: string,
    ) =>
      new InvitationsService(
        deps.core.as(viewerId),
        deps.auth,
        organisation,
        inviterRole,
        localeOfRequest(),
      ),
  };
}

export type Services = ReturnType<typeof services>;
