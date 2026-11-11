import { invalid } from "../shared/errors";

// A janus account id is a UUID; anything else names no member (400 on `id`).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idOrInvalidAccount(given: string, path = "id") {
  if (!UUID.test(given)) {
    throw invalid([{ path, code: "validation.errors.invalid" }]);
  }
  return given.toLowerCase();
}
