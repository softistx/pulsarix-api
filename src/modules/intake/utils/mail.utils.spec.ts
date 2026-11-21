import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { clip, hostPageLink, unsubscribeSecret, wantsMail } from "./mail.utils";

const mailable = {
  id: "r",
  email: "a@x.io",
  emailsOff: false,
  erasedAt: null,
};

describe("wantsMail", () => {
  test("a report with an address, e-mails on and its data kept gets mail", () => {
    expect(wantsMail(mailable)).toBe(true);
  });

  test("no address, e-mails off or erased data gets none", () => {
    expect(wantsMail({ ...mailable, email: null })).toBe(false);
    expect(wantsMail({ ...mailable, emailsOff: true })).toBe(false);
    expect(wantsMail({ ...mailable, erasedAt: new Date() })).toBe(false);
  });
});

describe("clip", () => {
  test("a long reply is cut with an ellipsis, a short one kept", () => {
    expect(clip("short")).toBe("short");
    const long = clip("x".repeat(1_500));
    expect(long).toHaveLength(1_001);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("unsubscribeSecret", () => {
  test("derives one stable secret per ticket secret", () => {
    expect(unsubscribeSecret("a")).toBe(unsubscribeSecret("a"));
    expect(unsubscribeSecret("a")).not.toBe(unsubscribeSecret("b"));
  });
});

describe("hostPageLink", () => {
  const widgetKeyId = new ObjectId();
  const allowed = async () => ["https://app.example.com"];

  test("the page is linked only when its origin is one the key allows", async () => {
    expect(
      await hostPageLink(
        { pageUrl: "https://app.example.com/a?b=1", widgetKeyId },
        allowed,
      ),
    ).toBe("https://app.example.com/a?b=1");
    expect(
      await hostPageLink(
        { pageUrl: "https://evil.test/a", widgetKeyId },
        allowed,
      ),
    ).toBeNull();
  });

  test("no page, or one that is not a URL, gives no link", async () => {
    expect(
      await hostPageLink({ pageUrl: null, widgetKeyId }, allowed),
    ).toBeNull();
    expect(
      await hostPageLink({ pageUrl: "not a url", widgetKeyId }, allowed),
    ).toBeNull();
  });
});
