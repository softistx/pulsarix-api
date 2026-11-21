import { describe, expect, test } from "bun:test";
import { readTicket, signTicket, type TicketClaims } from "./tickets.utils";

const SECRET = "s".repeat(40);
const claims: TicketClaims = {
  organisationId: "a".repeat(24),
  keyId: "b".repeat(24),
  reportId: "c".repeat(24),
  slot: "d".repeat(24),
  type: "image/png",
  size: 1_234,
  expiresAt: 1_800_000_000_000,
  decoy: false,
};
const part = (ticket: string, index: number) =>
  ticket.split(".")[index] as string;
const payloadOf = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("signTicket and readTicket", () => {
  test("a ticket reads back as the claims it was signed with", () => {
    const ticket = signTicket(SECRET, claims);
    expect(ticket.split(".")).toHaveLength(2);
    expect(readTicket(SECRET, ticket)).toEqual(claims);
    expect(
      readTicket(SECRET, signTicket(SECRET, { ...claims, decoy: true })),
    ).toEqual({
      ...claims,
      decoy: true,
    });
  });

  test("another secret, a changed payload or a changed signature reads as nothing", () => {
    const ticket = signTicket(SECRET, claims);
    expect(readTicket("o".repeat(40), ticket)).toBeNull();
    const forgedPayload = payloadOf({ ...claims, size: 9_999_999 });
    expect(
      readTicket(SECRET, `${forgedPayload}.${part(ticket, 1)}`),
    ).toBeNull();
    expect(
      readTicket(SECRET, `${part(ticket, 0)}.${part(ticket, 1)}x`),
    ).toBeNull();
    expect(
      readTicket(SECRET, `${part(ticket, 0)}.${"A".repeat(43)}`),
    ).toBeNull();
  });

  test("a damaged token reads as nothing, never throws", () => {
    const ticket = signTicket(SECRET, claims);
    for (const bad of [
      "",
      "garbage",
      ".",
      "a.",
      ".b",
      `${ticket}.extra`,
      "x".repeat(1_001),
    ]) {
      expect(readTicket(SECRET, bad)).toBeNull();
    }
  });

  test("a payload that is signed but is not a ticket's claims reads as nothing", () => {
    // Signed with the right secret, so only the shape check can refuse it.
    const sign = (payload: string) =>
      signTicket(SECRET, claims).replace(
        part(signTicket(SECRET, claims), 0),
        payload,
      );
    expect(readTicket(SECRET, sign("%%%"))).toBeNull();
    const incomplete = { ...claims } as Partial<TicketClaims>;
    delete incomplete.slot;
    const forged = signTicket(SECRET, incomplete as TicketClaims);
    expect(readTicket(SECRET, forged)).toBeNull();
    const badSlot = signTicket(SECRET, { ...claims, slot: "not-an-id" });
    expect(readTicket(SECRET, badSlot)).toBeNull();
    const zero = signTicket(SECRET, { ...claims, size: 0 });
    expect(readTicket(SECRET, zero)).toBeNull();
  });
});

// `env` is read once at import and frozen, so each case runs the function in
// a process of its own, with the variables set.
async function secretWith(vars: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  delete env["INTAKE_TICKET_SECRET"];
  delete env["API_PROXY_SECRET"];
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined) env[name] = value;
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import { serverTicketSecret } from "./src/modules/intake/intake.server"; console.log(serverTicketSecret()); process.exit(0)',
    ],
    { cwd: process.cwd(), env, stdout: "pipe", stderr: "ignore" },
  );
  return (await new Response(child.stdout).text()).trim().split("\n").at(-1);
}

describe("serverTicketSecret", () => {
  test("INTAKE_TICKET_SECRET wins when it is set", async () => {
    expect(
      await secretWith({
        INTAKE_TICKET_SECRET: "z".repeat(40),
        API_PROXY_SECRET: "p".repeat(40),
      }),
    ).toBe("z".repeat(40));
  });

  test("without it, the key derives from API_PROXY_SECRET and never is that secret", async () => {
    const derived = await secretWith({ API_PROXY_SECRET: "p".repeat(40) });
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toContain("p".repeat(40));
    expect(await secretWith({ API_PROXY_SECRET: "p".repeat(40) })).toBe(
      derived,
    );
    expect(await secretWith({ API_PROXY_SECRET: "q".repeat(40) })).not.toBe(
      derived,
    );
  });

  test("with neither, a fixed development key is used", async () => {
    const development = await secretWith({});
    expect(development).toMatch(/^[0-9a-f]{64}$/);
    expect(await secretWith({})).toBe(development);
  });
});
