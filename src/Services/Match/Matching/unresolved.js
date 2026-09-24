/**
 * COZULEMEYEN LIG / TAKIM ADLARININ TOPLANMASI
 *
 * Alias veritabaninda karsiligi olmayan adlari toplar ve en yakin
 * adaylariyla birlikte raporlar.
 *
 * ONEMLI: bulanik eslestiricinin bulduklari alias dosyalarina OTOMATIK
 * YAZILMAZ. Yanlis bir alias butun eslestirme sistemini bozar ve hatayi
 * geriye donuk izlemek cok zorlasir. Bunun yerine ayri bir "oneri" ciktisi
 * uretilir; kalici alias'i insan onaylar.
 *
 * Production'da log kalabaligi yapmamasi icin varsayilan KAPALI
 * (MATCH_DEBUG_UNRESOLVED=1 ile acilir).
 */

import { similarityRatio } from "./similarity.js";
import { listTeamRecords, listLeagueRecords } from "./aliases.js";
import { normalizeTeamName } from "./team.js";
import { normalizeLeagueName } from "./league.js";
import { MATCH_CONFIG } from "./config.js";

export class UnresolvedCollector {
  constructor(options = {}) {
    this.enabled = options.enabled ?? MATCH_CONFIG.collectUnresolved;
    this.maxSuggestions =
      options.maxSuggestions ?? MATCH_CONFIG.maxSuggestionsPerName;
    this.threshold = options.threshold ?? MATCH_CONFIG.suggestionThreshold;

    /** anahtar -> kayit (ayni ad bir kez raporlanir) */
    this.teams = new Map();
    this.leagues = new Map();

    // Aday listeleri bir kez hazirlanir; her ad icin yeniden kurulmaz.
    this._teamPool = null;
    this._leaguePool = null;
  }

  get teamPool() {
    this._teamPool ??= listTeamRecords().map((r) => ({
      canonical: r.canonical,
      normalized: normalizeTeamName(r.canonical),
    }));
    return this._teamPool;
  }

  get leaguePool() {
    this._leaguePool ??= listLeagueRecords().map((r) => ({
      canonical: r.canonical,
      normalized: normalizeLeagueName(r.canonical),
    }));
    return this._leaguePool;
  }

  _suggest(pool, normalized) {
    const out = [];

    for (const entry of pool) {
      const score = similarityRatio(normalized, entry.normalized);
      if (score >= this.threshold) {
        out.push({
          canonical: entry.canonical,
          score: Math.round(score) / 100,
        });
      }
    }

    return out.sort((a, b) => b.score - a.score).slice(0, this.maxSuggestions);
  }

  /** Alias tablosunda karsiligi olmayan bir takim adini kaydeder. */
  addTeam({ source, sport, league, team }) {
    if (!this.enabled || !team) return;

    const normalized = normalizeTeamName(team, { sport });
    const key = `${source}|${sport}|${normalized}`;
    if (this.teams.has(key)) return;

    this.teams.set(key, {
      type: "unresolved_team",
      source,
      sport,
      league,
      team,
      normalized,
      possibleMatches: this._suggest(this.teamPool, normalized),
    });
  }

  /** Alias tablosunda karsiligi olmayan bir lig adini kaydeder. */
  addLeague({ source, sport, country, league }) {
    if (!this.enabled || !league) return;

    const normalized = normalizeLeagueName(league);
    const key = `${source}|${sport}|${normalized}`;
    if (this.leagues.has(key)) return;

    this.leagues.set(key, {
      type: "unresolved_league",
      source,
      sport,
      country: country ?? null,
      league,
      normalized,
      possibleMatches: this._suggest(this.leaguePool, normalized),
    });
  }

  /** Yalnizca ONERISI OLAN kayitlar raporlanir; geri kalani gurultudur. */
  report() {
    if (!this.enabled) return null;

    const withSuggestions = (list) =>
      [...list.values()].filter((x) => x.possibleMatches.length > 0);

    return {
      teams: withSuggestions(this.teams),
      leagues: withSuggestions(this.leagues),
      counts: {
        teams: this.teams.size,
        leagues: this.leagues.size,
      },
    };
  }
}
