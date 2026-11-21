import { describe, expect, test } from "bun:test";
import { generate, identified, token } from "~/identity";
import { codeOfBody, countingLimits, intakeKit } from "~/intake";
import { IDENTITY_HEADER } from "./identity.service";

describe("the rate limit per reporter", () => {
  test("the eleventh report of one reporter is a 429; another reporter is not", async () => {
    // The address limits lifted: only the reporter's counts here.
    const limits = countingLimits();
    const open = {
      consume: async () => ({ allowed: true, retryAfter: 0 }),
    };
    const own = await intakeKit({
      limits: {
        ...limits,
        intakeIpKey: open,
        intakeKey: open,
        intakeEmail: open,
      },
    });
    const secret = await generate(own);
    for (let i = 0; i < 10; i++) {
      expect((await identified(own, token(secret, own))).response.status).toBe(
        200,
      );
    }
    const over = await identified(own, token(secret, own));
    expect(over.response.status).toBe(429);
    expect(codeOfBody(over.body)).toBe("intake.errors.too-many-requests");
    const other = await identified(own, token(secret, own, { sub: "user-43" }));
    expect(other.response.status).toBe(200);
  });
});

describe("CORS", () => {
  test("the preflight allows the identity header", async () => {
    const kit = await intakeKit();
    const response = await kit.kit.app.fetch(
      new Request("https://api.pulsarix.test/public/graphql", {
        method: "OPTIONS",
        headers: { origin: kit.site },
      }),
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      IDENTITY_HEADER,
    );
  });
});
