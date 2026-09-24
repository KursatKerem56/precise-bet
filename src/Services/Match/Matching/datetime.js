/**
 * DATE / TIME NORMALISATION AND COMPARISON
 *
 * Time comparison ALWAYS goes through a single epoch number. Comparing the
 * "HH:MM" string alone would read 23:50 versus 00:10 as a 23 hour 40 minute
 * difference, when the real difference is 20 minutes.
 */

import { MATCH_CONFIG } from "./config.js";

/** Europe/Istanbul = UTC+3 (no daylight saving). */
export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 180;

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})/;

/**
 * "2026-09-18" + "20:00" -> epoch ms (treating local time as UTC+offset).
 *
 * Returns null when there is no time -- it never GUESSES. The caller treats
 * a record without a time as "not comparable".
 */
export function toEpochMs(
  date,
  time,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES
) {
  const d = DATE_RE.exec(String(date ?? ""));
  const t = TIME_RE.exec(String(time ?? ""));
  if (!d || !t) return null;

  const hour = +t[1];
  const minute = +t[2];
  if (hour > 23 || minute > 59) return null;

  return (
    Date.UTC(+d[1], +d[2] - 1, +d[3], hour, minute) - offsetMinutes * MINUTE_MS
  );
}

/** The epoch value of the date alone (no time); used for date buckets. */
export function dateToEpochMs(date) {
  const d = DATE_RE.exec(String(date ?? ""));
  return d ? Date.UTC(+d[1], +d[2] - 1, +d[3]) : null;
}

/** "2026-09-18" + 1 day -> "2026-09-19". null on an invalid date. */
export function dateKeyOffset(date, days) {
  const base = dateToEpochMs(date);
  if (base == null) return null;
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Produces the normalised time information for a match.
 * The value is STORED on the match object; it is not parsed over and over.
 */
export function normalizeTimestamp(date, time, offsetMinutes) {
  return {
    date,
    time: time ?? null,
    epoch: toEpochMs(date, time, offsetMinutes),
    dateEpoch: dateToEpochMs(date),
  };
}

/** The difference between two epochs in MINUTES (b - a). */
export function calculateTimeDifference(epochA, epochB) {
  if (epochA == null || epochB == null) return null;
  return Math.round((epochB - epochA) / MINUTE_MS);
}

/**
 * Compares the times of two matches.
 *
 * @returns {{
 *   diffMinutes: number|null,
 *   comparable: boolean,
 *   isDifferent: boolean,
 *   plausible: boolean
 * }}
 *
 * `plausible` = COULD these two records be two representations of the SAME
 * match? For records on different days, if the time difference exceeds a
 * reasonable midnight shift (12 hours by default) the two records are NOT
 * the same match. Without this check, real data reported "the same teams'
 * other match the next day" as a 1380 minute "time difference".
 */
export function compareMatchTimes(a, b, options = {}) {
  const toleranceMinutes =
    options.toleranceMinutes ?? MATCH_CONFIG.toleranceMinutes;
  const maxAdjacent =
    options.maxAdjacentDayDiffMinutes ?? MATCH_CONFIG.maxAdjacentDayDiffMinutes;

  const diffMinutes = calculateTimeDifference(a.epoch, b.epoch);

  if (diffMinutes == null) {
    // The time is missing: do not eliminate, but do not call it "different"
    // either.
    return {
      diffMinutes: null,
      comparable: false,
      isDifferent: false,
      plausible: true,
    };
  }

  const sameDay = a.date === b.date;
  const plausible = sameDay || Math.abs(diffMinutes) <= maxAdjacent;

  return {
    diffMinutes,
    comparable: true,
    isDifferent: Math.abs(diffMinutes) > toleranceMinutes,
    plausible,
  };
}
