import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

const app = createApp();
const graphql = (query: string) =>
  app.fetch(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );

describe("probes", () => {
  test("GET /health answers 200", async () => {
    const response = await app.fetch(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
  });

  test("GET /ready answers 200 while it has no dependency", async () => {
    const response = await app.fetch(new Request("http://localhost/ready"));
    expect(response.status).toBe(200);
  });
});

describe("graphql", () => {
  test("version answers the package version", async () => {
    const response = await graphql("{ version }");
    expect(await response.json()).toEqual({ data: { version: "0.1.0" } });
  });
});
