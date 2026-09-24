/**
 * CENTRAL SPORT CATALOG
 *
 * Sport information used to live in five separate places, none of them aware
 * of the others:
 *   - betist    : canonicalSportName() + TARGET_ORDER
 *   - virusbet  : SPORTS[] (sportId constants) + TARGET_ORDER
 *   - mavibet   : SPORTS[] (sportId + tree constants) + TARGET_ORDER
 *   - compare-match-times.js : SPORT_CANON + SPORT_ORDER
 *   - Match.service.ts       : a nested ternary
 *
 * Adding a new sport meant changing all five, and the ternary in
 * Match.service.ts silently mapped every unknown sport to TENNIS.
 *
 * This is now the single source. Adding a sport = adding one line below.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SITE IDS ARE NOT HERE
 *
 * All three ALREADY report the sport id in the data we fetch:
 *   betist   -> in the home.php menu   (check__{id} + sport-name)
 *   virusbet -> in the swarm sport tree (id + alias + name)
 *   mavibet  -> in the disciplinesV2 dump (id + name)
 *
 * So hardcoding the ids would be unnecessary and brittle (when a site
 * changes an id, the wrong sport is fetched silently). Instead the site
 * reports a NAME and we normalise it through `aliases`. No id constants.
 *
 * `key`  -> the top level key in the JSON output (backwards compatibility)
 * `id`   -> the normalised in-app value (same as EMatchSport)
 */

import { foldName } from "../Core/text.js";

/**
 * Note: the four sports in LEGACY_KEYS are ALWAYS present in the output JSON
 * (even when empty), because existing consumers rely on those four keys.
 */
const LEGACY_KEYS = ["FUTBOL", "BASKETBOL", "VOLEYBOL", "TENIS"];

/**
 * @type {Array<{ key: string, id: string, aliases: string[] }>}
 *
 * The order matters: the output and the reports use it. The first four are
 * identical to the old TARGET_ORDER.
 */
const SPORTS = [
  { key: "FUTBOL", id: "FOOTBALL", aliases: ["futbol", "soccer", "football"] },
  { key: "BASKETBOL", id: "BASKETBALL", aliases: ["basketbol", "basketball"] },
  { key: "VOLEYBOL", id: "VOLLEYBALL", aliases: ["voleybol", "volleyball"] },
  { key: "TENIS", id: "TENNIS", aliases: ["tenis", "tennis"] },

  {
    key: "MASA_TENISI",
    id: "TABLE_TENNIS",
    aliases: ["masa tenisi", "table tennis"],
  },
  {
    key: "BUZ_HOKEYI",
    id: "ICE_HOCKEY",
    aliases: ["buz hokeyi", "ice hockey"],
  },
  {
    key: "AMERIKAN_FUTBOLU",
    id: "AMERICAN_FOOTBALL",
    // mavibet abbreviates this as "Am. Football".
    aliases: ["amerikan futbolu", "american football", "am football"],
  },
  { key: "BEYZBOL", id: "BASEBALL", aliases: ["beyzbol", "baseball"] },
  { key: "HENTBOL", id: "HANDBALL", aliases: ["hentbol", "handball"] },
  {
    key: "RAGBI",
    id: "RUGBY",
    // The Union/League split is deliberately merged into ONE key: betist
    // says "Rugby"/"Ragbi" while virusbet and mavibet say "Rugby Union"/
    // "Rugby League". Keeping them apart would mean the same match could
    // never match across sites.
    aliases: ["rugby", "ragbi", "rugby union", "rugby league"],
  },
  { key: "KRIKET", id: "CRICKET", aliases: ["kriket", "cricket"] },
  { key: "MMA", id: "MMA", aliases: ["mma", "mixed martial arts"] },
  { key: "BOKS", id: "BOXING", aliases: ["boks", "boxing"] },
  {
    key: "FORMULA_1",
    id: "FORMULA_1",
    aliases: ["formula 1", "formula one", "f1"],
  },
  {
    key: "MOTOR_SPORLARI",
    id: "MOTORSPORT",
    aliases: [
      "araba yarislari",
      "auto racing",
      "motor racing",
      "motorsport",
      "nascar",
    ],
  },
  {
    key: "SALON_FUTBOLU",
    id: "FUTSAL",
    aliases: ["salon futbolu", "futsal"],
  },
  { key: "SUTOPU", id: "WATER_POLO", aliases: ["sutopu", "water polo"] },
  { key: "DART", id: "DARTS", aliases: ["dart", "darts"] },
  { key: "SNOOKER", id: "SNOOKER", aliases: ["snooker", "bilardo"] },
  { key: "GOLF", id: "GOLF", aliases: ["golf"] },
  { key: "SATRANC", id: "CHESS", aliases: ["santranc", "satranc", "chess"] },
  {
    key: "BISIKLET",
    id: "CYCLING",
    aliases: ["bisiklet yarisi", "bisiklet", "cycling"],
  },
  { key: "BIATLON", id: "BIATHLON", aliases: ["biatlon", "biathlon"] },
  {
    key: "KAYAK",
    id: "SKIING",
    aliases: [
      "kayak",
      "alpine skiing",
      "cross country skiing",
      "ski jumping",
      "skiing",
    ],
  },
  {
    key: "AVUSTRALYA_FUTBOLU",
    id: "AUSTRALIAN_FOOTBALL",
    aliases: ["avustralya futbolu", "australian football", "aussie rules"],
  },
  { key: "FLOORBALL", id: "FLOORBALL", aliases: ["floorball"] },
  {
    key: "GAELIC_FUTBOLU",
    id: "GAELIC_FOOTBALL",
    aliases: ["gaelic football"],
  },
  { key: "HURLING", id: "HURLING", aliases: ["hurling"] },
  { key: "BANDY", id: "BANDY", aliases: ["bandy", "ball hockey"] },
  {
    key: "YELKEN",
    id: "SAILING",
    aliases: ["yelkencilik", "sailing", "yachting"],
  },
  { key: "SORF", id: "SURFING", aliases: ["sorf", "surfing"] },
  { key: "KABADDI", id: "KABADDI", aliases: ["kabaddi"] },
  { key: "SUMO", id: "SUMO", aliases: ["sumo"] },
  {
    key: "HALI_HOKEYI",
    id: "FIELD_HOCKEY",
    aliases: ["field hockey", "hali hokeyi"],
  },
];

// --- Indexes (built once when the module is loaded) -------------------------

/** foldName(alias) -> sport record */
const byAlias = new Map();

/** key -> sport record */
const byKey = new Map();

/** id -> sport record */
const byId = new Map();

for (const sport of SPORTS) {
  byKey.set(sport.key, sport);
  byId.set(sport.id, sport);

  // The key and the id are valid aliases themselves, so both
  // MATCH_SPORTS=FUTBOL and MATCH_SPORTS=FOOTBALL work.
  for (const alias of [...sport.aliases, sport.key, sport.id]) {
    byAlias.set(foldName(alias), sport);
  }
}

/** The order used in the output and in the reports. */
const SPORT_ORDER = SPORTS.map((sport) => sport.key);

/**
 * Converts the sport name reported by a site into a catalog record.
 * Returns `null` for a sport we do not know -- it never GUESSES.
 *
 * @param {...(string|null|undefined)} names Names to try (name, alias, short name)
 */
function resolveSport(...names) {
  for (const name of names) {
    if (!name) continue;

    const found = byAlias.get(foldName(name));

    if (found) return found;
  }

  return null;
}

const getSportByKey = (key) => byKey.get(String(key)) ?? null;

const getSportById = (id) => byId.get(String(id)) ?? null;

/**
 * Determines which sports to fetch.
 *
 * When `MATCH_SPORTS` is empty, ALL sports in the catalog are targets; a
 * sport a site does not have is never discovered, so no request is wasted on
 * it. To restrict the set, provide the environment variable, e.g.:
 *
 *     MATCH_SPORTS=FUTBOL,BASKETBOL,VOLEYBOL,TENIS   (the old behaviour)
 *
 * @param {string} [raw]
 * @returns {Set<string>|null} the set of allowed keys; null = all of them
 */
function resolveEnabledSportKeys(raw = process.env.MATCH_SPORTS) {
  const value = String(raw ?? "").trim();

  if (!value) return null;

  const keys = new Set();

  for (const part of value.split(/[,\s]+/).filter(Boolean)) {
    const sport = resolveSport(part);

    if (sport) keys.add(sport.key);
  }

  return keys.size ? keys : null;
}

export {
  SPORTS,
  SPORT_ORDER,
  LEGACY_KEYS,
  resolveSport,
  getSportByKey,
  getSportById,
  resolveEnabledSportKeys,
};
