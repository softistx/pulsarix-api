import type { AppTenancy } from "../../config/db";
import { tenancyFailure } from "../tenancy";

// Registers an organisation and creates and migrates its database, active as
// soon as it returns. `actor` stamps it: an account id, or SYSTEM_ACTOR for the
// operator's bootstrap. A taken slug is 409 `tenancy.errors.slug-taken`. Shared
// by `OrganisationsService.create` and the bootstrap command.
export async function provisionOrganisation(
  tenancy: Pick<AppTenancy, "provision">,
  input: { slug: string; name: string },
  actor: string,
) {
  try {
    return await tenancy.provision(input, actor);
  } catch (error) {
    throw tenancyFailure(error);
  }
}
