/**
 * SHARED OUTPUT MODEL
 *
 * All three fetchers had copied the `addEventsToOutput` + `sortOutput` pair
 * almost verbatim (~60 lines x 3). This holds that shared part; the only
 * site specific thing is how each one extracts these fields from a raw
 * record.
 *
 * The output shape is UNCHANGED:
 *
 *   { "FUTBOL": { "Ulke - Lig": { "2026-09-18": [
 *       { eventId, leagueId, home, away, time } ] } }, ... }
 */

import { LEGACY_KEYS, SPORT_ORDER } from "../Sports/catalog.js";

const collator = new Intl.Collator("tr");

/**
 * Accumulator that collects, deduplicates and sorts matches.
 */
class MatchOutput {
  /**
   * @param {{ logger?: object, dateFilter?: (date: string) => boolean }} [options]
   */
  constructor(options = {}) {
    this.logger = options.logger ?? null;

    this.dateFilter = options.dateFilter ?? null;

    /** @type {Map<string, Map<string, Map<string, object[]>>>} sport -> league -> date -> matches */
    this.bySport = new Map();

    /** Dedup within a sport: the same match can arrive from several sources. */
    this.seenEventIds = new Map();

    this.stats = { added: 0, duplicate: 0, skipped: 0, filtered: 0 };
  }

  /**
   * Adds a single match. A missing/broken record does not stop the WHOLE
   * fetch; it is counted and skipped, so partial corruption stays visible
   * without being fatal.
   *
   * @returns {boolean} true when it was added
   */
  add(sportKey, event) {
    const home = String(event?.home ?? "").trim();
    const away = String(event?.away ?? "").trim();
    const date = String(event?.date ?? "").trim();

    // Without both sides this is not a match (outrights, "who wins the
    // title" and so on).
    if (!sportKey || !home || !away || !date) {
      this.stats.skipped++;
      return false;
    }

    if (this.dateFilter && !this.dateFilter(date)) {
      this.stats.filtered++;
      return false;
    }

    const eventId = event.eventId != null ? String(event.eventId) : "";

    if (eventId) {
      let seen = this.seenEventIds.get(sportKey);

      if (!seen) {
        seen = new Set();
        this.seenEventIds.set(sportKey, seen);
      }

      if (seen.has(eventId)) {
        this.stats.duplicate++;
        return false;
      }

      seen.add(eventId);
    }

    const leagueName = String(
      event.leagueName || (event.leagueId ? `LIG_${event.leagueId}` : "")
    ).trim();

    const countryName = String(event.countryName ?? "").trim();

    const leagueKey =
      countryName && leagueName
        ? `${countryName} - ${leagueName}`
        : leagueName || countryName || "BILINMEYEN_LIG";

    let leagues = this.bySport.get(sportKey);

    if (!leagues) {
      leagues = new Map();
      this.bySport.set(sportKey, leagues);
    }

    let dates = leagues.get(leagueKey);

    if (!dates) {
      dates = new Map();
      leagues.set(leagueKey, dates);
    }

    let matches = dates.get(date);

    if (!matches) {
      matches = [];
      dates.set(date, matches);
    }

    matches.push({
      eventId,
      leagueId: event.leagueId != null ? String(event.leagueId) : "",
      home,
      away,
      time: String(event.time ?? ""),
    });

    this.stats.added++;

    return true;
  }

  /** Total number of matches in one sport. */
  countFor(sportKey) {
    let total = 0;

    for (const dates of this.bySport.get(sportKey)?.values() ?? []) {
      for (const matches of dates.values()) total += matches.length;
    }

    return total;
  }

  get total() {
    return this.stats.added;
  }

  /**
   * Produces a sorted, plain JSON object.
   *
   * LEGACY_KEYS are always present (even when empty): existing consumers
   * (compare-match-times, Match.service, the panel UI) rely on those four
   * keys existing. New sports are appended after them in catalog order, so
   * the output only GROWS instead of breaking.
   */
  toSorted() {
    const keys = [
      ...LEGACY_KEYS,
      ...SPORT_ORDER.filter(
        (key) => !LEGACY_KEYS.includes(key) && this.bySport.has(key)
      ),
      // A key that is not in the catalog should never reach here; it is
      // still appended at the end so nothing disappears silently.
      ...[...this.bySport.keys()].filter((key) => !SPORT_ORDER.includes(key)),
    ];

    const sorted = {};

    for (const sportKey of keys) {
      if (sorted[sportKey]) continue;

      sorted[sportKey] = {};

      const leagues = this.bySport.get(sportKey);

      if (!leagues) continue;

      for (const leagueKey of [...leagues.keys()].sort((a, b) =>
        collator.compare(a, b)
      )) {
        const dates = leagues.get(leagueKey);

        sorted[sportKey][leagueKey] = {};

        for (const date of [...dates.keys()].sort()) {
          sorted[sportKey][leagueKey][date] = dates.get(date).sort((a, b) => {
            const byTime = String(a.time).localeCompare(String(b.time));

            if (byTime !== 0) return byTime;

            return collator.compare(
              `${a.home}-${a.away}`,
              `${b.home}-${b.away}`
            );
          });
        }
      }
    }

    return sorted;
  }

  /** "SPORT: n leagues / m matches" lines for the log. */
  summaryLines() {
    const lines = [];

    for (const [sportKey, leagues] of this.bySport) {
      lines.push(
        `${sportKey}: ${leagues.size} leagues / ${this.countFor(sportKey)} matches`
      );
    }

    return lines;
  }
}

/**
 * Helper for a filter such as `--tarih 2026-09-18`.
 * Returns null when no bound is given at all (no filtering).
 */
function createDateFilter({ dates, from, to } = {}) {
  const allowed = dates?.length ? new Set(dates) : null;

  if (!allowed && !from && !to) return null;

  return (date) => {
    if (allowed) return allowed.has(date);

    if (from && date < from) return false;

    if (to && date > to) return false;

    return true;
  };
}

export { MatchOutput, createDateFilter };
