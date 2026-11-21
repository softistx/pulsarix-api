import { describe, expect, test } from "bun:test";
import type { ClientReportDocument } from "../models";
import { declineReasonShown, pageOf, reporterEmailOf } from "./reports.utils";

describe("declineReasonShown", () => {
  test("a reason is shown only when the team wrote it knowing so", () => {
    expect(
      declineReasonShown({ declineReason: "no", declineReasonPublic: true }),
    ).toBe("no");
    expect(
      declineReasonShown({ declineReason: "no", declineReasonPublic: false }),
    ).toBeNull();
    expect(declineReasonShown({ declineReason: "no" })).toBeNull();
  });
});

describe("reporterEmailOf", () => {
  test("an identified report keeps the host's e-mail, never the form's", () => {
    const identity = { reporterKey: "u", reporterName: null, email: null };
    expect(reporterEmailOf(identity, { email: "form@x.io" })).toBeNull();
    expect(
      reporterEmailOf({ ...identity, email: "host@x.io" }, { email: "f@x.io" }),
    ).toBe("host@x.io");
  });

  test("an unidentified report uses the form's address", () => {
    expect(reporterEmailOf(null, { email: "form@x.io" })).toBe("form@x.io");
    expect(reporterEmailOf(null, { email: "" })).toBeNull();
    expect(reporterEmailOf(null, {})).toBeNull();
  });
});

describe("pageOf", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
    })) as ClientReportDocument[];

  test("a full read has a next page, its cursor the last row kept", () => {
    const page = pageOf(rows(3), 2);
    expect(page.nodes.map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("r1");
  });

  test("a short read is the last page, with no cursor", () => {
    const page = pageOf(rows(2), 2);
    expect(page.hasNextPage).toBe(false);
    expect(page.endCursor).toBeNull();
  });
});
