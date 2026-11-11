import { refusalMapper } from "@alxia/access";
import { lazyScope, type TenantStore } from "@alxia/tenancy";
import { refuse } from "../access";
import type { Viewer } from "../auth/viewer";
import type { Organisation } from "./registry";

// A refusal of the tenancy layer as the API answers it: the same coded error
// (`tenancy.errors.*`, CONTEXT.md) with the status the store gave, mapped by the
// guards' own `refuse` (@alxia/access `refusalOf` recognises a `TenancyError`).
// Anything else is rethrown as it is.
export const tenancyFailure: (error: unknown) => unknown =
  refusalMapper(refuse);

// The scope of ONE request, resolved on first use and kept (`lazyScope`): a
// request that never asks (sign-in, a link, `viewer`) never reads the
// organisation header, the registry or the membership. The refusals (400
// header missing, 404 unknown organisation or not a member) are kept as well,
// so every guard of a request answers the same.
export function requestScope<C, K, M>(
  tenancy: Pick<TenantStore<C, K, Organisation, M>, "scope">,
  request: Request,
  viewer: Viewer | null,
) {
  const scope = lazyScope(tenancy, request, viewer);
  return async () => {
    try {
      return await scope();
    } catch (error) {
      throw tenancyFailure(error);
    }
  };
}
