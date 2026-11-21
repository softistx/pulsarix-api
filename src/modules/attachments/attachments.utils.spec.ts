import { describe, expect, test } from "bun:test";
import { cleanFileName, urlOf } from "./attachments.utils";

describe("cleanFileName", () => {
  test("keeps the last path segment", () => {
    expect(cleanFileName("a/b\\c/report.pdf")).toBe("report.pdf");
  });
  test("drops control and direction characters", () => {
    expect(cleanFileName("re‮pdf.exe\u0000")).toBe("repdf.exe");
  });
  test("refuses blank, dot and missing names", () => {
    expect(cleanFileName(null)).toBeNull();
    expect(cleanFileName("  ")).toBeNull();
    expect(cleanFileName("..")).toBeNull();
    expect(cleanFileName("dir/.")).toBeNull();
  });
  test("caps the name at 200 characters", () => {
    expect(cleanFileName("x".repeat(300))?.length).toBe(200);
  });
});

describe("urlOf", () => {
  test("is on the app's own origin", () => {
    expect(urlOf("org/key.png")).toMatch(/^\/media\/[^/]+\/org\/key\.png$/);
  });
});
