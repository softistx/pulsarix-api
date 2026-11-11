// What a member is in an organisation (plan Q13): ONE role per organisation,
// one of these built-in roles, which live in code. From the most to the least
// privileged. The permissions a role holds are declared by the module
// manifests (catalogue.ts), never listed here.
export const roles = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof roles)[number];

export const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (roles as readonly string[]).includes(value);

// A role as janus names its relation on the `organization` object, which must
// be camelCase: the four roles are already.
export const relationOf = (role: Role) =>
  role.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
