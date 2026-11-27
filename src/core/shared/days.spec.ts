import { describe, expect, test } from "bun:test";
import {
  addDays,
  dayIn,
  daysBetween,
  earlierDay,
  laterDay,
  startOfDayIn,
} from "./days";

const iso = (date: Date) => date.toISOString();

describe("startOfDayIn", () => {
  test("is the local midnight of the day `now` falls in, east of UTC", () => {
    // Kiritimati is UTC+14: 12:00Z is already 02:00 on the next local day.
    const now = new Date("2026-11-19T12:00:00Z");
    expect(iso(startOfDayIn("Pacific/Kiritimati", now))).toBe(
      "2026-11-19T10:00:00.000Z",
    );
    expect(dayIn("Pacific/Kiritimati", now)).toBe("2026-11-20");
  });

  test("is the local midnight west of UTC, the day before the UTC date", () => {
    const now = new Date("2026-11-19T03:00:00Z");
    expect(iso(startOfDayIn("America/Los_Angeles", now))).toBe(
      "2026-11-18T08:00:00.000Z",
    );
    expect(dayIn("America/Los_Angeles", now)).toBe("2026-11-18");
  });

  test("is UTC midnight for UTC", () => {
    const now = new Date("2026-11-19T23:59:59Z");
    expect(iso(startOfDayIn("UTC", now))).toBe("2026-11-19T00:00:00.000Z");
  });

  test("follows the clock change: a 23-hour and a 25-hour day (Paris)", () => {
    // 2026-03-29: clocks go forward at 02:00, the day lasts 23 hours.
    const spring = new Date("2026-03-29T12:00:00Z");
    expect(iso(startOfDayIn("Europe/Paris", spring))).toBe(
      "2026-03-28T23:00:00.000Z",
    );
    const after = new Date("2026-03-30T12:00:00Z");
    expect(iso(startOfDayIn("Europe/Paris", after))).toBe(
      "2026-03-29T22:00:00.000Z",
    );
    // 2026-10-25: clocks go back, the day lasts 25 hours.
    const fall = new Date("2026-10-25T12:00:00Z");
    expect(iso(startOfDayIn("Europe/Paris", fall))).toBe(
      "2026-10-24T22:00:00.000Z",
    );
    const next = new Date("2026-10-26T00:30:00Z");
    expect(iso(startOfDayIn("Europe/Paris", next))).toBe(
      "2026-10-25T23:00:00.000Z",
    );
  });

  test("the instant just before and at the local midnight fall in different days", () => {
    const midnight = new Date("2026-03-28T23:00:00Z");
    expect(dayIn("Europe/Paris", new Date(midnight.getTime() - 1))).toBe(
      "2026-03-28",
    );
    expect(dayIn("Europe/Paris", midnight)).toBe("2026-03-29");
    expect(iso(startOfDayIn("Europe/Paris", midnight))).toBe(iso(midnight));
  });
});

describe("addDays and daysBetween", () => {
  test("move a day across months, years and leap days", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-11-30", 0)).toBe("2026-11-30");
  });

  test("count the days between two days, negative backwards", () => {
    expect(daysBetween("2026-11-20", "2026-12-04")).toBe(14);
    expect(daysBetween("2026-12-04", "2026-11-20")).toBe(-14);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});

describe("earlierDay and laterDay", () => {
  test("pick by calendar order, across a year end", () => {
    expect(earlierDay("2026-12-31", "2027-01-01")).toBe("2026-12-31");
    expect(laterDay("2026-12-31", "2027-01-01")).toBe("2027-01-01");
    expect(laterDay("2026-11-30", "2026-11-30")).toBe("2026-11-30");
  });
});
