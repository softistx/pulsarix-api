import { describe, expect, test } from "bun:test";
import { declineReasonShown, reporterEmailOf } from "./reports.utils";

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
