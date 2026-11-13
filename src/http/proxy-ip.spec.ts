import { describe, expect, test } from "bun:test";
import { proxyIp } from "./proxy-ip";

const SECRET = "s".repeat(32);
const server = (address: string) =>
  ({ requestIP: () => ({ address }) }) as unknown as Bun.Server<unknown>;
const request = (secret?: string, path = "/graphql") =>
  new Request(`http://api${path}`, {
    headers: {
      "x-forwarded-for": "203.0.113.7",
      ...(secret === undefined ? {} : { "x-pulsarix-proxy-secret": secret }),
    },
  });
const trusted = ["172.16.0.0/12"];

describe("proxyIp", () => {
  test("a matching secret keeps the TRUSTED_PROXIES behaviour", () => {
    const ip = proxyIp({ trusted, secret: SECRET });
    expect(ip(request(SECRET), server("172.18.0.2"))).toBe("203.0.113.7");
  });

  test("a wrong or missing secret falls back to the socket address", () => {
    const ip = proxyIp({ trusted, secret: SECRET });
    expect(ip(request("x".repeat(32)), server("172.18.0.2"))).toBe(
      "172.18.0.2",
    );
    expect(ip(request("short"), server("172.18.0.2"))).toBe("172.18.0.2");
    expect(ip(request(), server("172.18.0.2"))).toBe("172.18.0.2");
  });

  test("/public/ keeps the forwarded address without the secret (the widget comes through Traefik)", () => {
    const ip = proxyIp({ trusted, secret: SECRET });
    expect(
      ip(request(undefined, "/public/graphql"), server("172.18.0.2")),
    ).toBe("203.0.113.7");
  });

  test("/graphql from a trusted proxy without the secret gets the socket address", () => {
    const ip = proxyIp({ trusted, secret: SECRET });
    expect(ip(request(), server("172.18.0.2"))).toBe("172.18.0.2");
  });

  test("unset, the forwarded address is honoured as before", () => {
    const ip = proxyIp({ trusted });
    expect(ip(request(), server("172.18.0.2"))).toBe("203.0.113.7");
    expect(ip(request("anything"), server("172.18.0.2"))).toBe("203.0.113.7");
  });

  test("an untrusted connection is never believed, secret or not", () => {
    const ip = proxyIp({ trusted, secret: SECRET });
    expect(ip(request(SECRET), server("198.51.100.9"))).toBe("198.51.100.9");
  });
});
