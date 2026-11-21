import { describe, expect, test } from "bun:test";
import type { Context } from "../http/context";
import { dataLoaders } from "./data-loaders";

describe("dataLoaders", () => {
  test("one set per request context, none shared between requests", () => {
    const first = {} as Context;
    const second = {} as Context;
    expect(dataLoaders(first)).toBe(dataLoaders(first));
    expect(dataLoaders(first)).not.toBe(dataLoaders(second));
    expect(dataLoaders(first).projects.statuses).not.toBe(
      dataLoaders(second).projects.statuses,
    );
  });
});
