import * as access from "@alxia/access";
import type { Viewer } from "../auth/viewer";
import { fail } from "../shared/errors";

// The guards of @alxia/access, each refusal thrown as this API's coded error
// (`fail`): 401 `auth.errors.unauthenticated`, 403 `auth.errors.forbidden`
// (with the permission as param), and the scope's own 400
// `tenancy.errors.organization-required` and 404
// `tenancy.errors.unknown-organization` passed through. The order of the
// refusals is the package's: 401, then the scope's, then 403.
export const refuse = (refusal: access.Refusal) =>
  fail(refusal.code as Parameters<typeof fail>[0], {
    ...(Object.keys(refusal.params).length > 0 && {
      params: { ...refusal.params },
    }),
    status: refusal.status,
  });

export type { GuardContext } from "@alxia/access";

export const requireViewer: typeof access.requireViewer = (ctx) => {
  try {
    return access.requireViewer(ctx);
  } catch (error) {
    throw access.refusalMapper(refuse)(error);
  }
};
export const can: typeof access.can = access.withRefusals(refuse, access.can);
// The organisation's second-factor requirement (A1b): once an organisation
// requires one, a member without an active TOTP reads nothing of it until they
// enrol (403 `auth.errors.second-factor-required`). Every guard that resolves
// the scope applies it, so no resolver can forget it; `enrollSecondFactor` and
// `activateSecondFactor` need no scope, so enrolment stays open.
type GatedScope = {
  member: unknown;
  tenant: { requireSecondFactor?: boolean };
};

export function enforceSecondFactor(
  viewer: { hasSecondFactor?: boolean } | null,
  scope: GatedScope,
) {
  if (scope.tenant.requireSecondFactor && !viewer?.hasSecondFactor) {
    throw fail("auth.errors.second-factor-required", { status: 403 });
  }
}

// Wraps a guard, keeping its signature: the scope it returns is checked.
function gated<G extends (...args: never[]) => Promise<GatedScope>>(
  guard: G,
): G {
  const wrapped = async (...args: unknown[]) => {
    const scope = await (
      guard as unknown as (...a: unknown[]) => Promise<GatedScope>
    )(...args);
    const [ctx] = args as [{ viewer: Viewer | null }];
    enforceSecondFactor(ctx.viewer, scope);
    return scope;
  };
  return wrapped as unknown as G;
}

export const requireMember = gated(
  access.withRefusals(refuse, access.requireMember),
);
export const requirePermission = gated(
  access.withRefusals(refuse, access.requirePermission),
);
export const requireAnyPermission = gated(
  access.withRefusals(refuse, access.requireAnyPermission),
);
export const requireSelf: typeof access.requireSelf = access.withRefusals(
  refuse,
  access.requireSelf,
);
