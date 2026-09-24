/**
 * THE LEAGUE MATCHING PIPELINE
 *
 *   Stage 1 : The normalised league names are identical
 *   Stage 2 : Both resolve to the SAME canonical league id (alias)
 *   Stage 3 : Country + normalised name match
 *   Stage 4 : Guarded fuzzy match (the sport context is MANDATORY)
 *
 * ---------------------------------------------------------------------------
 * WHY THE LEAGUE IS NOT A HARD BUCKET KEY
 *
 * The three sites write the same league very differently:
 *
 *   betist : "International Clubs - UEFA Champions League"
 *   mavibet: "Europe - UEFA Champions League - League Stage"
 *   virusbet: "Europe - UEFA Champions League"
 *
 * In real data almost none of betist's 150 football leagues is spelled
 * EXACTLY the same way on mavibet. Making the league a mandatory bucket key
 * would lose most of the matches. So the league is:
 *
 *   - a HARD REJECT when it is RELIABLY different (both sides resolve to a
 *     canonical league and the ids differ)
 *   - a HARD REJECT when the qualifiers differ
 *     (Women / U21 / Reserve)
 *   - a SOFT SIGNAL (a score) in every other case
 */

import { foldText, tokenize, stripSeason } from "./text.js";
import { similarityRatio } from "./similarity.js";
import { resolveCountry, resolveLeagueAlias } from "./aliases.js";
import {
  LEAGUE_QUALIFIERS,
  LEAGUE_QUALIFIER_CLASS,
  INDIVIDUAL_SPORTS,
  MATCH_CONFIG,
} from "./config.js";

/** Season/group/stage noise in a league name. */
const STAGE_NOISE = new Set([
  "league",
  "stage",
  "group",
  "round",
  "matchday",
  "statistics",
  "phase",
  "season",
  "regular",
  "playoff",
  "playoffs",
]);

const normalizeCache = new Map();

/** Normalises a league name (the season information is dropped). */
export function normalizeLeagueName(name) {
  const key = String(name ?? "");
  const hit = normalizeCache.get(key);
  if (hit !== undefined) return hit;

  const value = foldText(stripSeason(key));
  normalizeCache.set(key, value);
  return value;
}

/**
 * Splits a "Country - League Name" key into its parts.
 * The country name is canonicalised through the alias table (Holland ->
 * Netherlands).
 */
export function splitLeagueKey(leagueKey) {
  const raw = String(leagueKey ?? "");
  const sep = raw.indexOf(" - ");

  const countryRaw = sep > -1 ? raw.slice(0, sep).trim() : null;
  const name = sep > -1 ? raw.slice(sep + 3).trim() : raw.trim();

  const { country, isRegion, known } = countryRaw
    ? resolveCountry(countryRaw)
    : { country: null, isRegion: false, known: false };

  return { countryRaw, country, isRegion, countryKnown: known, name };
}

/**
 * Splits the qualifiers out of a league name.
 * "Primera Division, Women" -> core "primera division", quals {women}
 * "U20, COSAFA Cup"         -> core "cosafa cup",       quals {u20}
 */
export function splitLeagueQualifiers(foldedName) {
  const quals = new Set();
  const core = [];

  for (const token of tokenize(foldedName)) {
    if (LEAGUE_QUALIFIERS.has(token)) {
      // "womens" and "women" say the same thing.
      quals.add(token.replace(/s$/, "").replace(/^kadinlar?$/, "women"));
      continue;
    }
    if (STAGE_NOISE.has(token)) continue;
    core.push(token);
  }

  return { core: core.join(" ") || foldedName, quals };
}

const sameSet = (a, b) => {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

/**
 * Resolves a league key. The result is STORED on the match object; it is
 * not recomputed on every comparison.
 *
 * @param {string} sportKey  the catalog sport key (FUTBOL ...)
 * @param {string} leagueKey "Country - League Name"
 */
export function resolveLeague(sportKey, leagueKey) {
  const { countryRaw, country, isRegion, countryKnown, name } =
    splitLeagueKey(leagueKey);
  const folded = normalizeLeagueName(name);
  const { core, quals } = splitLeagueQualifiers(folded);

  const alias =
    resolveLeagueAlias(sportKey, country, core) ??
    resolveLeagueAlias(sportKey, country, folded);

  return {
    raw: leagueKey,
    name,
    countryRaw,
    country,
    isRegion,
    countryKnown,
    folded,
    core,
    quals,
    canonicalId: alias?.record.id ?? null,
    canonicalConfident: alias?.confident ?? false,
  };
}

/**
 * Compares two resolved leagues.
 *
 * @returns {{ score: number, stage: string, hardReject: boolean, reason?: string }}
 */
export function compareLeagues(a, b, context = {}) {
  if (!a || !b) return { score: 0, stage: "unknown", hardReject: false };

  // --- HARD CONSTRAINT: qualifiers ------------------------------------
  // "Primera Division" and "Primera Division, Women" are separate
  // competitions.
  //
  // The check runs on the UNION of the LEAGUE and TEAM qualifiers. One site
  // can put the qualifier in the league name and another in the team name:
  //   betist : "USA - NWSL, Women"        teams "... (w)"
  //   mavibet: "United States - NWSL"     teams "... (W)"
  // Both are the same competition; looking only at the league name would
  // split them apart.
  const effective = (league, teamQuals) => {
    const merged = new Set();
    for (const q of league.quals)
      merged.add(LEAGUE_QUALIFIER_CLASS.get(q) ?? q);
    for (const q of teamQuals ?? [])
      merged.add(LEAGUE_QUALIFIER_CLASS.get(q) ?? q);
    return merged;
  };

  // The check is not applied in individual sports: the athlete's name is
  // already unique while tournament naming is wildly inconsistent.
  const skipQualifierCheck = INDIVIDUAL_SPORTS.has(context.sport);

  if (
    !skipQualifierCheck &&
    !sameSet(
      effective(a, context.teamQualifiersA),
      effective(b, context.teamQualifiersB)
    )
  ) {
    return {
      score: 0,
      stage: "rejected",
      hardReject: true,
      reason: "league-qualifier-mismatch",
    };
  }

  // --- HARD CONSTRAINT: a reliable canonical league difference ---------
  // We only reject when BOTH SIDES resolved confidently; one sided or low
  // confidence resolutions can eliminate the wrong thing.
  if (
    a.canonicalId &&
    b.canonicalId &&
    a.canonicalConfident &&
    b.canonicalConfident &&
    a.canonicalId !== b.canonicalId
  ) {
    return {
      score: 0,
      stage: "rejected",
      hardReject: true,
      reason: "different-canonical-league",
    };
  }

  // --- Stage 2: the same canonical league ------------------------------
  if (a.canonicalId && b.canonicalId && a.canonicalId === b.canonicalId) {
    return { score: 100, stage: "alias", hardReject: false };
  }

  // --- HARD CONSTRAINT: a different COUNTRY ----------------------------
  //
  // "England - Premier League" and "Belarus - Premier League" are NOT THE
  // SAME LEAGUE; the only thing they share is the league name. That is why
  // the country is a hard constraint.
  //
  // The constraint is LIMITED by the `regions` list in the alias table. The
  // country field does not always hold a country:
  //   - a geographic bucket : "Europe", "World", "International Clubs"
  //   - a sport name        : "Rugby Union - France Pro D2"   (betist)
  //   - a tour name         : "ATP - Saint Tropez"            (betist)
  //   - a parent country    : "United Kingdom - Elite League" (mavibet)
  //                           betist calls the same league
  //                           "England - Elite League"
  //
  // Those values are flagged as `regions`, so they eliminate nothing.
  // Values that are unrecognised but are a REAL country ("Belarus", say)
  // apply the constraint normally -- with an allowlist we would miss
  // exactly the case we want to guard against.
  if (
    a.country &&
    b.country &&
    !a.isRegion &&
    !b.isRegion &&
    a.country !== b.country
  ) {
    return {
      score: 0,
      stage: "rejected",
      hardReject: true,
      reason: "different-country",
    };
  }

  // --- Stage 1 / 3: exact (with the country context) -------------------
  if (a.core && a.core === b.core) {
    const sameCountry = a.country && b.country && a.country === b.country;
    return {
      score: 100,
      stage: sameCountry ? "exact-with-country" : "exact",
      hardReject: false,
    };
  }

  // --- Stage 4: guarded fuzzy ------------------------------------------
  const score = similarityRatio(a.core, b.core);
  return { score, stage: "fuzzy", hardReject: false };
}

/** The plain backwards compatible score (the old `leagueSimilarity` signature). */
export const leagueSimilarity = (a, b) =>
  similarityRatio(normalizeLeagueName(a), normalizeLeagueName(b));

export const clearLeagueCache = () => normalizeCache.clear();

export { MATCH_CONFIG };
