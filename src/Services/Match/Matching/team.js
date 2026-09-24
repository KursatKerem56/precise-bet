/**
 * THE TEAM MATCHING PIPELINE
 *
 *   Stage 1 : The normalised names are identical        -> 100
 *   Stage 2 : Both resolve to the SAME canonical team   -> 100 (alias)
 *   Stage 3 : Guarded fuzzy comparison                  -> 0-100
 *
 * A QUALIFIER check runs before every stage: "Barcelona" is NOT the same
 * team as "Barcelona B", "Barcelona Women" or "Barcelona U19", and they are
 * never matched however similar the names look (a hard constraint).
 */

import {
  foldText,
  tokenize,
  foldExonym,
  splitQualifiers,
  sameQualifiers,
  normalizeQualifier,
  stripGeneric,
} from "./text.js";
import { similarityRatio } from "./similarity.js";
import { resolveTeamAlias } from "./aliases.js";
import {
  MATCH_CONFIG,
  WEAK_TOKENS,
  US_LEAGUE_SPORTS,
  TEAM_QUALIFIERS,
  SPORT_GENERIC_TOKENS,
} from "./config.js";

/**
 * City abbreviations used in US leagues.
 *
 * CAREFUL - these used to be expanded in EVERY sport and corrupted 49 team
 * names in real data:
 *
 *   "Deportivo La Coruna"     -> "deportivo LOS ANGELES coruna"
 *   "Gimnasia La Plata"       -> "gimnasia LOS ANGELES plata"
 *   "Sepsi Sf. Gheorghe"      -> "sepsi SAN FRANCISCO gheorghe"
 *
 * They are now expanded only in sports that have a US league AND only when
 * the token is written in UPPERCASE in the raw text ("LA Galaxy" yes, "La
 * Plata" no).
 */
const CITY_ABBREVIATIONS = {
  ny: "new york",
  la: "los angeles",
  sa: "san antonio",
  sf: "san francisco",
  gs: "golden state",
  okc: "oklahoma city",
  no: "new orleans",
  kc: "kansas city",
  gb: "green bay",
  ne: "new england",
  tb: "tampa bay",
  lv: "las vegas",
};

/** The set of tokens written in UPPERCASE in the raw name. */
function uppercaseTokens(raw) {
  const set = new Set();
  for (const piece of String(raw ?? "").split(/[\s.,'’`-]+/)) {
    if (
      piece.length >= 2 &&
      piece === piece.toUpperCase() &&
      /[A-Z]/.test(piece)
    ) {
      set.add(piece.toLowerCase());
    }
  }
  return set;
}

/** Cache for normalisation results: "sport\0name" -> normalised name. */
const normalizeCache = new Map();

/**
 * Merges consecutive single letter tokens into one abbreviation.
 *
 *   "C A Antoniano"    -> ["ca", "antoniano"]   ("ca" is later dropped as generic)
 *   "L. A. Galaxy"     -> ["la", "galaxy"]
 *   "N. E. Revolution" -> ["ne", "revolution"]
 *
 * The sites write the same abbreviation either joined or with dots; without
 * merging, "c a antoniano" and "ca antoniano" end up with different token
 * counts and the similarity drops for no good reason.
 */
function mergeInitials(tokens) {
  const out = [];
  let run = [];

  const flush = () => {
    if (run.length > 1) out.push(run.join(""));
    else if (run.length === 1) out.push(run[0]);
    run = [];
  };

  for (const token of tokens) {
    if (token.length === 1) {
      run.push(token);
      continue;
    }
    flush();
    out.push(token);
  }
  flush();

  return out;
}

/**
 * Reduces a team name to a comparison ready form.
 *
 * @param {string} name
 * @param {{ sport?: string }} [options] when sport is given, US city
 *        abbreviations are only expanded in the relevant sports.
 */
export function normalizeTeamName(name, options = {}) {
  const sport = options.sport ?? null;
  const cacheKey = `${sport ?? ""}\u0000${name ?? ""}`;

  const hit = normalizeCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const folded = foldText(name);

  // The input to stage 2: does the alias table hold this exact name?
  const alias = resolveTeamAlias(folded);
  const base = alias ? foldText(alias.canonical) : folded;

  let tokens = mergeInitials(tokenize(base)).map(foldExonym);

  if (sport && US_LEAGUE_SPORTS.has(sport)) {
    const upper = uppercaseTokens(name);
    const expanded = [];
    for (const token of tokens) {
      const city = CITY_ABBREVIATIONS[token];
      if (city && upper.has(token)) expanded.push(...city.split(" "));
      else expanded.push(token);
    }
    tokens = expanded;
  }

  let stripped = stripGeneric(tokens);

  const sportGeneric = sport ? SPORT_GENERIC_TOKENS.get(sport) : null;
  if (sportGeneric) {
    const narrowed = stripped.filter((t) => !sportGeneric.has(t));
    if (narrowed.length) stripped = narrowed;
  }

  const result = (stripped.length ? stripped : tokens).join(" ");

  normalizeCache.set(cacheKey, result);
  return result;
}

/**
 * Returns a name's canonical team identity (if any).
 * Qualifiers are PART of the identity: "Barcelona B" and "Barcelona" must
 * not resolve to the same one.
 */
export function resolveTeam(name, options = {}) {
  const folded = foldText(name);
  const direct = resolveTeamAlias(folded);
  if (direct) return direct;

  // Also try the core name with the qualifiers split off: the core of
  // "Manchester Utd U21" is "Manchester Utd" -> manchester_united, while the
  // u21 qualifier travels separately and is checked on its own during
  // comparison.
  const { core } = splitQualifiers(folded, "");
  if (core !== folded) {
    const viaCore = resolveTeamAlias(core);
    if (viaCore) return viaCore;
  }

  return resolveTeamAlias(normalizeTeamName(name, options));
}

/**
 * Does a name have a "strong" (distinctive) token?
 *
 * "City", "United", "Real" and "Sporting" carry no identity on their own.
 * If two names overlap ONLY in weak words, it does not count as a match.
 */
const hasStrongToken = (normalized) =>
  tokenize(normalized).some((t) => !WEAK_TOKENS.has(t));

/** How many tokens two normalised names share (strong and weak separately). */
function sharedTokens(a, b) {
  const setB = new Set(tokenize(b));
  let strong = 0;
  let weak = 0;

  for (const t of new Set(tokenize(a))) {
    if (!setB.has(t)) continue;
    if (WEAK_TOKENS.has(t)) weak++;
    else strong++;
  }

  return { strong, weak };
}

/**
 * Compares two team names.
 *
 * @returns {{ score: number, stage: "exact"|"alias"|"fuzzy"|"rejected", reason?: string }}
 */
export function compareTeams(a, b, options = {}) {
  const na = normalizeTeamName(a, options);
  const nb = normalizeTeamName(b, options);

  if (!na || !nb) return { score: 0, stage: "rejected", reason: "empty" };

  // --- HARD CONSTRAINT: qualifiers ------------------------------------
  // The comparison runs on the raw (folded) name; while stripping generic
  // affixes, normalisation can eat the qualifier too.
  const fa = foldText(a);
  const fb = foldText(b);
  const ignore = options.ignoreQualifiers ?? null;
  const pa = splitQualifiers(fa, fb, ignore);
  const pb = splitQualifiers(fb, fa, ignore);

  if (!sameQualifiers(pa.quals, pb.quals)) {
    return { score: 0, stage: "rejected", reason: "qualifier-mismatch" };
  }

  // --- Stage 1: exact --------------------------------------------------
  if (na === nb) return { score: 100, stage: "exact" };

  // --- Stage 2: alias --------------------------------------------------
  const ra = resolveTeam(a, options);
  const rb = resolveTeam(b, options);
  if (ra && rb && ra.id === rb.id) {
    return { score: MATCH_CONFIG.teamAliasScore, stage: "alias" };
  }

  // --- Stage 3: guarded fuzzy ------------------------------------------
  const score = similarityRatio(
    normalizeTeamName(pa.core, options),
    normalizeTeamName(pb.core, options)
  );

  // When both names are nothing but weak words ("City" vs "City"), do not
  // decide.
  if (!hasStrongToken(na) && !hasStrongToken(nb)) {
    return { score: 0, stage: "rejected", reason: "no-strong-token" };
  }

  // The "Manchester City" / "Leicester City" guard: when the ONLY thing in
  // common is a weak word and the strong tokens do not overlap at all, the
  // match is not accepted.
  //
  // CAREFUL: the condition MUST be tied to "a shared weak token EXISTS".
  // Otherwise names that share no token but are different spellings of the
  // same name would be eliminated too:
  //   "Baracaldo" / "Barakaldo", "Nordsjalland" / "Nordsjaelland"
  const shared = sharedTokens(na, nb);

  if (
    score >= MATCH_CONFIG.teamThreshold &&
    shared.strong === 0 &&
    shared.weak > 0
  ) {
    // Drop the weak words and compare WHAT IS LEFT. "Manchester" and
    // "Leicester" are not alike -> only "City" really is shared and the
    // match is rejected. But "Salfrod" and "Salford" are alike -> that is a
    // typo variant and must not be rejected.
    const strongOnly = (n) =>
      tokenize(n)
        .filter((t) => !WEAK_TOKENS.has(t))
        .join(" ");

    const coreSimilarity = similarityRatio(strongOnly(na), strongOnly(nb));

    if (coreSimilarity < MATCH_CONFIG.weakOverlapCoreThreshold) {
      return { score: 0, stage: "rejected", reason: "only-weak-overlap" };
    }
  }

  return { score, stage: "fuzzy" };
}

/**
 * The union of the qualifiers appearing in a match's team names.
 *
 * Evaluated TOGETHER WITH the league qualifier: one site writes the league
 * as "USA - NWSL, Women" while another says "United States - NWSL", yet on
 * both sides the teams carry "(W)". A check looking only at the league name
 * was throwing away these 24 correct matches.
 *
 * Explicitly written affixes (women / u21 / reserve ...) and the standard
 * "(W)" marker of women's teams are collected. OTHER single letter tokens
 * (name initials such as tennis's "Recek D") do NOT count as qualifiers.
 */
export function matchTeamQualifiers(match) {
  const quals = new Set();

  for (const raw of [match.home, match.away]) {
    const tokens = tokenize(foldText(raw));

    tokens.forEach((token, index) => {
      if (TEAM_QUALIFIERS.has(token)) {
        quals.add(normalizeQualifier(token));
        return;
      }

      // "Racing Louisville (W)" -> "racing louisville w"
      if (token === "w" && index === tokens.length - 1 && tokens.length > 1) {
        quals.add("women");
      }
    });
  }

  return quals;
}

/** The plain backwards compatible score (the old `teamSimilarity` signature). */
export const teamSimilarity = (a, b, options) =>
  compareTeams(a, b, options).score;

/** Clears the normalisation cache, for tests/diagnostics. */
export const clearTeamCache = () => normalizeCache.clear();

export { CITY_ABBREVIATIONS };
