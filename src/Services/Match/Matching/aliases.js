/**
 * ALIAS DATABASE LOADER
 *
 * team_aliases.json and league_aliases.json are read ONCE WHEN THE MODULE
 * LOADS and turned into Map indexes. There is NO disk read or array scan per
 * comparison:
 *
 *   normalizedAlias                      -> canonicalTeamId     (O(1))
 *   sport|country|normalizedLeagueAlias  -> canonicalLeagueId   (O(1))
 *
 * Because an alias match is treated as more reliable than a fuzzy one, these
 * files are NEVER UPDATED AUTOMATICALLY; what the fuzzy matcher proposes
 * goes into a separate "suggestions" output via unresolved.js.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { foldText } from "./text.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A broken/missing alias file must not take the whole comparison down:
 * running without aliases (fuzzy matching only) beats not running at all. */
function loadJson(fileName, fallback) {
  try {
    return JSON.parse(readFileSync(join(HERE, fileName), "utf8"));
  } catch (error) {
    console.warn(
      `[MATCHING] could not read ${fileName}, continuing without aliases: ${error.message}`
    );
    return fallback;
  }
}

/* =========================================================================
 * TEAM ALIAS INDEX
 * ====================================================================== */

const teamData = loadJson("team_aliases.json", { teams: {} });

/** foldText(alias) -> { id, canonical } */
const teamByAlias = new Map();

/** id -> { id, canonical, aliases } */
const teamById = new Map();

for (const [id, entry] of Object.entries(teamData.teams ?? {})) {
  // Documentation keys such as "_comment" are not records.
  if (id.startsWith("_") || !entry || typeof entry !== "object") continue;

  const canonical = entry.canonical ?? id;
  const record = { id, canonical, aliases: entry.aliases ?? [] };
  teamById.set(id, record);

  const names = new Set([canonical, ...(entry.aliases ?? [])]);

  // Source specific spellings (see the same structure in
  // league_aliases.json). The real data of the three sites currently needs
  // NO source specific rule -- the same variant shows up on more than one
  // site -- but the schema supports it.
  for (const list of Object.values(entry.sources ?? {})) {
    for (const name of list ?? []) names.add(name);
  }

  for (const name of names) {
    const key = foldText(name);
    if (!key) continue;

    const clash = teamByAlias.get(key);
    if (clash && clash.id !== id) {
      console.warn(
        `[MATCHING] team alias clash: "${name}" is both ${clash.id} and ${id}`
      );
      continue;
    }

    teamByAlias.set(key, record);
  }
}

/** Converts a normalised name into a canonical team record; null if absent. */
export const resolveTeamAlias = (foldedName) =>
  teamByAlias.get(foldedName) ?? null;

export const getTeamById = (id) => teamById.get(id) ?? null;

/* =========================================================================
 * LEAGUE ALIAS INDEX
 * ====================================================================== */

const leagueData = loadJson("league_aliases.json", {
  countries: {},
  regions: [],
  leagues: {},
});

/** foldText(country spelling) -> canonical country name */
const countryByAlias = new Map();

for (const [canonical, aliases] of Object.entries(leagueData.countries ?? {})) {
  for (const name of [canonical, ...(aliases ?? [])]) {
    const key = foldText(name);
    if (key) countryByAlias.set(key, canonical);
  }
}

/** Keys that are a region bucket, NOT a country. */
const regionKeys = new Set(
  (leagueData.regions ?? []).map((r) => foldText(r)).filter(Boolean)
);

/**
 * Canonicalises a country name.
 *
 * `known` = is this value a country we RECOGNISE in the alias table? A
 * country mismatch is only used as a HARD constraint when BOTH sides are
 * recognised. Otherwise values betist puts in place of the country, such as
 * "Rugby Union" / "ATP", would wrongly eliminate genuine matches.
 *
 * @returns {{ country: string|null, isRegion: boolean, known: boolean }}
 */
export function resolveCountry(raw) {
  const key = foldText(raw);
  if (!key) return { country: null, isRegion: false, known: false };

  if (regionKeys.has(key))
    return { country: null, isRegion: true, known: false };

  const canonical = countryByAlias.get(key);

  return {
    country: canonical ?? String(raw).trim(),
    isRegion: false,
    known: canonical !== undefined,
  };
}

/** "sport|country|leagueAlias" -> league record */
const leagueByKey = new Map();

/** id -> league record */
const leagueById = new Map();

/** Country-free fallback index (sport + name only): name -> league records */
const leagueByNameOnly = new Map();

const leagueKey = (sportKey, country, foldedName) =>
  `${sportKey ?? "*"}|${foldText(country ?? "") || "*"}|${foldedName}`;

/**
 * Indexes the league records. The `sport` field is written as a catalog
 * alias ("football") and converted here into the catalog key ("FUTBOL") --
 * so the JSON stays readable while the code uses a single representation of
 * a sport.
 */
export function buildLeagueIndex(resolveSportKey) {
  leagueByKey.clear();
  leagueById.clear();
  leagueByNameOnly.clear();

  for (const [id, entry] of Object.entries(leagueData.leagues ?? {})) {
    if (id.startsWith("_") || !entry || typeof entry !== "object") continue;

    const sportKey = resolveSportKey(entry.sport);
    const record = {
      id,
      canonical: entry.canonical ?? id,
      sportKey,
      country: entry.country ?? null,
      region: entry.region ?? null,
    };

    leagueById.set(id, record);

    const names = new Set([record.canonical, ...(entry.aliases ?? [])]);
    for (const list of Object.values(entry.sources ?? {})) {
      for (const name of list ?? []) names.add(name);
    }

    for (const name of names) {
      const folded = foldText(name);
      if (!folded) continue;

      // The key with country: leagues of different countries sharing a name
      // ("Premier League" - England / Russia / Wales) are NEVER conflated.
      const withCountry = leagueKey(sportKey, record.country, folded);
      if (!leagueByKey.has(withCountry)) leagueByKey.set(withCountry, record);

      // A sport+name key for records that carry no country.
      if (!record.country) {
        const withoutCountry = leagueKey(sportKey, null, folded);
        if (!leagueByKey.has(withoutCountry))
          leagueByKey.set(withoutCountry, record);
      }

      const nameKey = `${sportKey ?? "*"}|${folded}`;
      if (!leagueByNameOnly.has(nameKey)) leagueByNameOnly.set(nameKey, []);
      leagueByNameOnly.get(nameKey).push(record);
    }
  }

  return leagueByKey.size;
}

/**
 * Resolves a league name to its canonical record.
 *
 * @param {string} sportKey    the catalog sport key (FUTBOL ...)
 * @param {string|null} country the canonical country name (null if absent)
 * @param {string} foldedName  the normalised league name
 * @returns {{ record: object, confident: boolean }|null}
 */
export function resolveLeagueAlias(sportKey, country, foldedName) {
  if (!foldedName) return null;

  const exact = leagueByKey.get(leagueKey(sportKey, country, foldedName));
  if (exact) return { record: exact, confident: true };

  // Country-free fallback: accepted when there is exactly ONE candidate,
  // but marked as LOW confidence. With more than one candidate ("Premier
  // League" exists in many countries) we do NOT decide.
  const candidates = leagueByNameOnly.get(`${sportKey ?? "*"}|${foldedName}`);
  if (!candidates || candidates.length !== 1) return null;

  const [candidate] = candidates;

  // CRITICAL: when the query HAS a country and the candidate belongs to a
  // DIFFERENT one, the fallback is NOT applied. Otherwise the name "Belarus
  // - Premier League" would resolve to the single matching record, that is
  // to ENGLAND's Premier League, and two different countries' leagues would
  // share one canonical id.
  //
  // Candidates without a country (continental tournaments such as the UEFA
  // Champions League) are outside this constraint; they have no country to
  // begin with.
  if (country && candidate.country && candidate.country !== country) {
    return null;
  }

  return { record: candidate, confident: false };
}

export const getLeagueById = (id) => leagueById.get(id) ?? null;

/** The canonical name list used to build suggestions (used by unresolved.js). */
export const listLeagueRecords = () => [...leagueById.values()];
export const listTeamRecords = () => [...teamById.values()];

export const ALIAS_STATS = {
  teams: teamById.size,
  teamAliases: teamByAlias.size,
  countries: countryByAlias.size,
  regions: regionKeys.size,
};
