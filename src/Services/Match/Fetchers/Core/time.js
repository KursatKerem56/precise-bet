/**
 * Date/time conversions.
 *
 * The three sites report time in THREE DIFFERENT units:
 *   betist   : "2026-09-18 20:00:00" (site local time, Europe/Istanbul)
 *   virusbet : unix SECONDS
 *   mavibet  : unix MILLISECONDS
 *
 * In the output they must all be "YYYY-MM-DD" + "HH:MM" in Turkish time;
 * otherwise the time comparator (compare-match-times) would see the same
 * match at two different times and produce phantom "differences".
 *
 * Building an Intl.DateTimeFormat is expensive (rebuilding it per match is a
 * cost repeated thousands of times), so it is cached per time zone.
 */

const DEFAULT_TIMEZONE = "Europe/Istanbul";

const UNKNOWN = Object.freeze({ date: "UNKNOWN_DATE", time: "" });

const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    formatterCache.set(timeZone, formatter);
  }

  return formatter;
}

/**
 * epoch ms -> { date, time } (in the given time zone).
 *
 * CAREFUL: `Number(null)` and `Number("")` both return zero. Without
 * filtering those out, a record with a missing startTime would silently land
 * on "1970-01-01" -- broken data would look like valid data.
 */
function formatEpochMs(epochMs, timeZone = DEFAULT_TIMEZONE) {
  if (epochMs === null || epochMs === undefined || epochMs === "") {
    return UNKNOWN;
  }

  const value = Number(epochMs);

  if (!Number.isFinite(value)) return UNKNOWN;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return UNKNOWN;

  const parts = getFormatter(timeZone).formatToParts(date);

  const pick = (type) => parts.find((part) => part.type === type)?.value;

  const year = pick("year");

  if (!year) return UNKNOWN;

  return {
    date: `${year}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}`,
  };
}

/** epoch seconds -> { date, time }. */
function formatEpochSeconds(epochSeconds, timeZone = DEFAULT_TIMEZONE) {
  if (epochSeconds === null || epochSeconds === undefined || epochSeconds === "") {
    return UNKNOWN;
  }

  const value = Number(epochSeconds);

  if (!Number.isFinite(value)) return UNKNOWN;

  return formatEpochMs(value * 1000, timeZone);
}

/**
 * "YYYY-MM-DD HH:MM[:SS]" -> { date, time }.
 *
 * The value already arrives in the site's local time, so NO time zone
 * conversion is applied; converting to a Date would shift it by the server's
 * own TZ.
 */
function parseLocalDateTime(value) {
  const match = String(value ?? "").match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?/
  );

  if (!match) return UNKNOWN;

  return { date: match[1], time: match[2] };
}

export {
  DEFAULT_TIMEZONE,
  formatEpochMs,
  formatEpochSeconds,
  parseLocalDateTime,
};
