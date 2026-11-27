// Calendar days in an IANA time zone, for what "today" means to an
// organisation (its `timeZone`), not to the server.

const formats = new Map<string, Intl.DateTimeFormat>();

function formatOf(timeZone: string) {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(timeZone, format);
  }
  return format;
}

// The wall clock of `instant` in `timeZone`, read as if it were UTC.
function wallClockAsUtc(timeZone: string, instant: number): number {
  const part = new Map<string, number>();
  for (const { type, value } of formatOf(timeZone).formatToParts(instant)) {
    part.set(type, Number(value));
  }
  const at = (type: string) => part.get(type) ?? 0;
  return Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    at("hour"),
    at("minute"),
    at("second"),
  );
}

// How far the zone is ahead of UTC at `instant`, in milliseconds.
const offsetAt = (timeZone: string, instant: number) =>
  wallClockAsUtc(timeZone, instant) - Math.floor(instant / 1000) * 1000;

// The day `now` falls in, in `timeZone`, as `YYYY-MM-DD`.
export function dayIn(timeZone: string, now: Date): string {
  return new Date(wallClockAsUtc(timeZone, now.getTime()))
    .toISOString()
    .slice(0, 10);
}

// The instant the day `now` falls in began in `timeZone`: its local midnight.
// The offset is read twice, since the one at `now` may differ from the one at
// midnight when the clocks changed in between.
export function startOfDayIn(timeZone: string, now: Date): Date {
  const local = Date.parse(`${dayIn(timeZone, now)}T00:00:00Z`);
  const first = local - offsetAt(timeZone, now.getTime());
  return new Date(local - offsetAt(timeZone, first));
}

// The day `n` days after (or before, when negative) a `YYYY-MM-DD` day.
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// The whole days from `from` to `to`, both `YYYY-MM-DD` (negative when `to`
// comes first).
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

// The earlier and the later of two `YYYY-MM-DD` days (they sort as text).
export const earlierDay = (a: string, b: string) => [a, b].sort()[0] as string;
export const laterDay = (a: string, b: string) => [a, b].sort()[1] as string;
