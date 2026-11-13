import { defineModule } from "@alxia/modules";
import typeDefs from "./access.graphqls" with { type: "text" };

// The built-in roles' GraphQL enum. The roles live in code (roles.ts) and the
// permissions in the manifests of the modules that guard something.
export const access = defineModule({ name: "access", typeDefs: [typeDefs] });
