/**
 * ORTAK CIKTI MODELI
 *
 * Uc fetcher da `addEventsToOutput` + `sortOutput` ciftini neredeyse birebir
 * kopyalamisti (~60 satir x 3). Burasi o ortak kismi tutar; site'a ozgu olan
 * tek sey, ham kayittan bu alanlari nasil cikardigindir.
 *
 * Cikti sekli DEGISMEDI:
 *
 *   { "FUTBOL": { "Ulke - Lig": { "2026-09-18": [
 *       { eventId, leagueId, home, away, time } ] } }, ... }
 */

import { LEGACY_KEYS, SPORT_ORDER } from "../Sports/catalog.js";

const collator = new Intl.Collator("tr");

/**
 * Maçları toplayan, tekilleştiren ve sıralayan biriktirici.
 */
class MatchOutput {
  /**
   * @param {{ logger?: object, dateFilter?: (date: string) => boolean }} [options]
   */
  constructor(options = {}) {
    this.logger = options.logger ?? null;

    this.dateFilter = options.dateFilter ?? null;

    /** @type {Map<string, Map<string, Map<string, object[]>>>} sport -> lig -> tarih -> maçlar */
    this.bySport = new Map();

    /** Spor ici tekillestirme: ayni mac birden fazla kaynaktan gelebiliyor. */
    this.seenEventIds = new Map();

    this.stats = { added: 0, duplicate: 0, skipped: 0, filtered: 0 };
  }

  /**
   * Tek bir maçı ekler. Eksik/bozuk kayit TUM fetch'i durdurmaz; sayaca
   * yazilip atlanir, boylece kismi bozukluk gorunur ama olumcul olmaz.
   *
   * @returns {boolean} eklendiyse true
   */
  add(sportKey, event) {
    const home = String(event?.home ?? "").trim();
    const away = String(event?.away ?? "").trim();
    const date = String(event?.date ?? "").trim();

    // Iki taraf yoksa bu bir mac degil (outright, "sampiyon kim olur" vb.).
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

  /** Bir spordaki toplam maç sayisi. */
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
   * Sirali, duz JSON nesnesi uretir.
   *
   * LEGACY_KEYS her zaman bulunur (bos olsa bile): mevcut tuketiciler
   * (compare-match-times, Match.service, panel UI) bu dort anahtarin
   * varligina guveniyor. Yeni sporlar bunlarin ardina, katalog sirasiyla
   * eklenir; boylece cikti yalnizca GENISLER, bozulmaz.
   */
  toSorted() {
    const keys = [
      ...LEGACY_KEYS,
      ...SPORT_ORDER.filter(
        (key) => !LEGACY_KEYS.includes(key) && this.bySport.has(key)
      ),
      // Katalogda olmayan bir anahtar buraya normalde hic gelmez; yine de
      // sessizce kaybolmasin diye sona ekleniyor.
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

  /** Log icin "SPOR: n lig / m mac" satirlari. */
  summaryLines() {
    const lines = [];

    for (const [sportKey, leagues] of this.bySport) {
      lines.push(
        `${sportKey}: ${leagues.size} lig / ${this.countFor(sportKey)} mac`
      );
    }

    return lines;
  }
}

/**
 * `--tarih 2026-09-18` benzeri bir filtre icin yardimci.
 * Hicbir sinir verilmezse null doner (filtre yok).
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
