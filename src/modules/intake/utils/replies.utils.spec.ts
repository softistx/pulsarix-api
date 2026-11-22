import { describe, expect, it } from "bun:test";
import { ObjectId } from "mongodb";
import { latest, publicCommentsFilter } from "./replies.utils";

describe("replies utils", () => {
  it("takes the later of two dates", () => {
    const a = new Date("2026-01-01");
    const b = new Date("2026-02-01");
    expect(latest(a, b)).toBe(b);
    expect(latest(b, a)).toBe(b);
    expect(latest(a, null)).toBe(a);
    expect(latest(undefined, null)).toBeNull();
  });

  it("filters the public comments of every linked issue from its link", () => {
    const one = new ObjectId();
    const two = new ObjectId();
    const linked = new Date("2026-03-01");
    const read = new Date("2026-04-01");
    expect(publicCommentsFilter([], null)).toBeNull();
    expect(
      publicCommentsFilter(
        [
          { issueId: one, since: null },
          { issueId: two, since: linked },
        ],
        read,
      ),
    ).toEqual({
      public: true,
      $or: [
        { issueId: one, createdAt: { $gt: read } },
        { issueId: two, createdAt: { $gt: read } },
      ],
    });
    expect(
      publicCommentsFilter([{ issueId: two, since: linked }], null),
    ).toEqual({
      public: true,
      $or: [{ issueId: two, createdAt: { $gt: linked } }],
    });
  });
});
