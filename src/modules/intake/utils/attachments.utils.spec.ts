import { describe, expect, test } from "bun:test";
import { attachmentsOn } from "./attachments.utils";

describe("attachmentsOn", () => {
  test("a key stored before the file fields existed has attachments on", () => {
    expect(attachmentsOn({})).toBe(true);
  });

  test("only an explicit false turns them off", () => {
    expect(attachmentsOn({ attachmentsEnabled: true })).toBe(true);
    expect(attachmentsOn({ attachmentsEnabled: false })).toBe(false);
  });
});
