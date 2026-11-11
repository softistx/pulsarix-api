// Fractional ranks: a rank is a string of digits read as a fraction, and
// compares by plain string order (MongoDB's default, by code point). A rank
// can always be made between two others, or before the first or after the
// last, without touching any other issue: a move writes ONE document.
// A rank never ends in the zero digit, so there is always room before it.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS.charAt(0);
const LAST = DIGITS.length - 1;

// The middle of the scale: the rank of the first issue of a column.
export const firstRank = DIGITS.charAt(Math.floor(DIGITS.length / 2));

function digit(char: string | undefined): number {
  return char === undefined ? 0 : DIGITS.indexOf(char);
}

// A rank strictly between `a` ("" for none) and `b` (null for none).
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const low = digit(a[0]);
  const high = b === null ? DIGITS.length : digit(b[0]);
  if (high - low > 1) return DIGITS.charAt(Math.round((low + high) / 2));
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(low) + midpoint(a.slice(1), null);
}

// The rank after `last` (the end of a column), or the first rank of an empty
// one. It counts up, so a long column grows by one digit every 30 issues
// rather than every few.
export function rankAfter(last: string | null): string {
  if (last === null) return firstRank;
  const tail = digit(last.slice(-1));
  if (tail < LAST) return last.slice(0, -1) + DIGITS.charAt(tail + 1);
  return last + firstRank;
}

// A rank strictly between two neighbours; `before` is the one above (null at
// the top of the column), `after` the one below (null at the end). Refuses
// (null) neighbours that are not in order.
export function rankBetween(
  before: string | null,
  after: string | null,
): string | null {
  if (before !== null && after !== null && before >= after) return null;
  if (after === null) return rankAfter(before);
  return midpoint(before ?? "", after);
}
