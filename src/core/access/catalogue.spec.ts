import { describe, expect, test } from "bun:test";
import { defineModule } from "@alxia/modules";
import { modules } from "../../modules/registry";
import { accessOf } from "./catalogue";
import { roles } from "./roles";

describe("the access catalogue, built from the manifests", () => {
  const access = accessOf(modules);

  test("the roles are the four of the plan, most privileged first", () => {
    expect(roles).toEqual(["owner", "admin", "member", "viewer"]);
  });

  test("the owner holds every declared permission", () => {
    expect(access.permissions).toEqual([
      "organisation:read",
      "organisation:manage",
      "member:read",
      "member:manage",
      "project:read",
      "project:manage",
      "issue:read",
      "issue:write",
      "issue:delete",
      "comment:read",
      "comment:write",
      "comment:delete",
      "attachment:read",
      "attachment:write",
      "attachment:delete",
    ]);
    expect(access.permissionsOf("owner")).toEqual(access.permissions);
  });

  test("the admin manages, the member and the viewer read", () => {
    expect(access.permissionsOf("admin")).toEqual(access.permissions);
    expect(access.permissionsOf("member")).toEqual([
      "organisation:read",
      "member:read",
      "project:read",
      "issue:read",
      "issue:write",
      "comment:read",
      "comment:write",
      "attachment:read",
      "attachment:write",
    ]);
    expect(access.permissionsOf("viewer")).toEqual([
      "organisation:read",
      "member:read",
      "project:read",
      "issue:read",
      "comment:read",
      "attachment:read",
    ]);
    expect(access.permissionsOf(null)).toEqual([]);
    expect(access.roleCan("member", "member:manage")).toBe(false);
  });

  test("a grant to an unknown role is refused at boot", () => {
    const bad = defineModule({
      name: "bad",
      permissions: ["bad:read"],
      defaultGrants: { editor: ["bad:read"] },
    });
    expect(() => accessOf([bad])).toThrow();
  });
});
