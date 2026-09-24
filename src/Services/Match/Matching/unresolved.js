/**
 * COLLECTING UNRESOLVED LEAGUE / TEAM NAMES
 *
 * Gathers the names that have no entry in the alias database and reports
 * them together with their closest candidates.
 *
 * IMPORTANT: what the fuzzy matcher finds is NEVER WRITTEN to the alias
 * files AUTOMATICALLY. A wrong alias breaks the entire matching system and
 * makes the mistake very hard to trace back. Instead a separate
 * "suggestion" output is produced; a human approves the permanent alias.
 *
 * OFF by default so it does not clutter production logs (enabled with
 * MATCH_DEBUG_UNRESOLVED=1).
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

    /** key -> record (the same name is reported once) */
    this.teams = new Map();
    this.leagues = new Map();

    // The candidate lists are built once, not rebuilt for every name.
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

  /** Records a team name that has no entry in the alias table. */
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

  /** Records a league name that has no entry in the alias table. */
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

  /** Only records WITH A SUGGESTION are reported; the rest is noise. */
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
