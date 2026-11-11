import { defineEnv } from "@alxia/env";
import { z } from "zod";

// Read once, at import: a malformed variable stops the process before it
// listens. `.env.example` lists them; Bun loads `.env` on every command.
// A0 reads only the port; the database, Redis, S3 and mail variables arrive
// with the slice that first uses each.
export const env = defineEnv({
  // number, optional, default 3000
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});
