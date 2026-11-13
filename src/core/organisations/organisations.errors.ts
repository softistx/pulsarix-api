import { fail } from "../shared/errors";

// An account owns at most 10 organisations (MAX_OWNED_ORGANISATIONS).
export const tooManyOrganisations = (max: number) =>
  fail("organisations.errors.too-many", { status: 409, params: { max } });
