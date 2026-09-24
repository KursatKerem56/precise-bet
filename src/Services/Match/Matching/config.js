/**
 * CENTRAL MATCHING SETTINGS
 *
 * The thresholds used to be scattered through compare-match-times.js, and
 * some of them (lowLeagueScore, teamScoreWhenLeagueLow) were never defined
 * in DEFAULTS at all -- meaning that safety check silently never ran. All
 * the numbers now live in one place.
 *
 * The values were chosen by looking at real data; the rationale for each is
 * written next to it.
 */

export const MATCH_CONFIG = {
  /* --- Team ---------------------------------------------------------- */

  /** The fuzzy score (0-100) two names need to count as "the same team".
   * 78: in the real data of the three sites the lowest correct match is ~82
   * (Namibya/Namibia) and the highest wrong match is ~73 (Manchester City/
   * Leicester City). 78 sits right between the two clusters. */
  teamThreshold: 78,

  /** The score for names that resolve to the same canonical team through an
   * alias. It is ALWAYS treated as more reliable than a fuzzy match. */
  teamAliasScore: 100,

  /** The threshold of the "only a weak word in common" guard.
   *
   * This is not a MATCHING threshold but a COINCIDENCE guard, which is why
   * it is lower than the main one. If the core names outside the weak word
   * are not even this similar, the overlap is a coincidence:
   *   "Manchester" / "Leicester" -> 50  (rejected, correctly)
   *   "Salfrod"    / "Salford"   -> 71  (accepted: a typo) */
  weakOverlapCoreThreshold: 65,

  /* --- League -------------------------------------------------------- */

  /** The fuzzy score a league name needs to count as "the same". */
  leagueThreshold: 55,

  /** Is a league match mandatory? By default no: the three sites write
   * league names very differently ("International Clubs - UEFA Champions
   * League" vs "Europe - UEFA Champions League - League Stage"), and
   * requiring it would lose most of the genuine matches. */
  requireLeague: false,

  /** When the league names are completely different, the team score is
   * expected to clear this bar. (It used to be undefined -> the check never
   * ran.) */
  lowLeagueScore: 35,
  teamScoreWhenLeagueLow: 88,

  /* --- Date / time ---------------------------------------------------- */

  /** A +-1 day neighbourhood is searched to catch shifts across midnight. */
  dateToleranceDays: 1,

  /** A difference of at most this many minutes counts as "the same time". */
  toleranceMinutes: 0,

  /** The upper bound (in minutes) for candidates on a NEIGHBOURING DAY.
   *
   * 2160 min = 36 hours. This is a SANITY bound, not a midnight tolerance:
   * since the same two teams do not meet again on consecutive days
   * (football/boxing/MMA/tennis), records that match on a neighbouring day
   * are really the SAME match with a DIFFERENT DATE written down, and that
   * is at least as valuable to the user as a time difference.
   *
   * So neighbouring-day candidates are NOT dropped; instead:
   *   - same-day candidates always rank ahead of them (crossDatePenalty)
   *   - the output flags them SEPARATELY as `tarihFarkli`
   * which keeps a misleading "time difference" such as 1380 min from being
   * reported on its own. */
  maxAdjacentDayDiffMinutes: 2160,

  /** The ranking penalty that puts a same-day candidate AHEAD of a
   * neighbouring-day one. When the same teams have a record both today and
   * tomorrow, the same-day match is the correct one. */
  crossDatePenalty: 500,

  /* --- Candidate narrowing (blocking) --------------------------------- */

  /** The length of the blocking key built from team name tokens.
   * 3 letters: on real data it keeps 2067 of 2068 correct matches (99.95%)
   * while cutting the candidate count to 4.4%. */
  blockingPrefixLength: 3,

  /* --- Confidence levels ---------------------------------------------- */

  /** Above this is "match", the band below it is "possible_match". */
  highConfidence: 0.92,
  possibleConfidence: 0.75,

  /* --- Diagnostics ---------------------------------------------------- */

  /** Collect the league/team names missing from the alias database.
   * Off by default so it does not clutter production logs; enabled with
   * MATCH_DEBUG_UNRESOLVED=1. */
  collectUnresolved: process.env.MATCH_DEBUG_UNRESOLVED === "1",

  /** How many candidates at most to list per name in the suggestion output. */
  maxSuggestionsPerName: 3,

  /** The lowest fuzzy score required to count as a suggestion. */
  suggestionThreshold: 80,
};

/**
 * TEAM QUALIFIERS
 *
 * "Athletic Bilbao" and "Athletic Bilbao B" are NOT THE SAME TEAM. These
 * affixes barely move the character similarity, so fuzzy matching cannot
 * tell them apart on its own; they are therefore extracted from the name
 * and compared SEPARATELY: if one side has it, the other MUST have it too.
 */
export const TEAM_QUALIFIERS = new Set([
  "ii",
  "iii",
  "u16",
  "u17",
  "u18",
  "u19",
  "u20",
  "u21",
  "u23",
  "res",
  "reserve",
  "reserves",
  "rezerv",
  "castilla",
  "atletic",
  "youth",
  "junior",
  "juniors",
  "jr",
  "genclik",
  "altyapi",
  "amateur",
  "amator",
  "women",
  "womens",
  "wom",
  "kadin",
  "kadinlar",
  "femenino",
  "feminin",
  "feminine",
  "fem",
  "ladies",
  "academy",
  "akademi",
]);

/**
 * LEAGUE QUALIFIERS
 *
 * The men's, women's and youth leagues of the same country are separate
 * competitions: "Argentina - Primera Division" is not the same league as
 * "Argentina - Primera Division, Women". These qualifiers have to be the
 * same on both sides.
 */
export const LEAGUE_QUALIFIERS = new Set([
  "u16",
  "u17",
  "u18",
  "u19",
  "u20",
  "u21",
  "u23",
  "women",
  "womens",
  "wom",
  "kadin",
  "kadinlar",
  "ladies",
  "femenino",
  "feminin",
  "feminine",
  "fem",
  "youth",
  "junior",
  "juniors",
  "juvenil",
  "genclik",
  "reserve",
  "reserves",
  "rezerv",
  "amateur",
  "amator",
]);

/**
 * At the league level, qualifiers are reduced to a COARSE CLASS.
 *
 * One site says "U19, Youth League" while another says "Division de Honor
 * Juvenil": both are youth leagues, but one names the age group and the
 * other only says "juvenil". What matters at the league level is the
 * CATEGORY (youth / women / reserve); the exact age group is already
 * checked separately in the TEAM name.
 */
export const LEAGUE_QUALIFIER_CLASS = new Map(
  Object.entries({
    u16: "youth",
    u17: "youth",
    u18: "youth",
    u19: "youth",
    u20: "youth",
    u21: "youth",
    u23: "youth",
    youth: "youth",
    junior: "youth",
    juniors: "youth",
    juvenil: "youth",
    genclik: "youth",
    women: "women",
    womens: "women",
    wom: "women",
    kadin: "women",
    kadinlar: "women",
    ladies: "women",
    femenino: "women",
    feminin: "women",
    feminine: "women",
    fem: "women",
    reserve: "reserve",
    reserves: "reserve",
    rezerv: "reserve",
    amateur: "amateur",
    amator: "amateur",
  })
);

/**
 * Words that carry NO STRONG IDENTITY on their own.
 *
 * "Manchester City" and "Leicester City" must not match just because they
 * share "City". These words produce no blocking key and count with a low
 * weight in token overlap.
 */
export const WEAK_TOKENS = new Set([
  "united",
  "utd",
  "city",
  "sporting",
  "racing",
  "real",
  "athletic",
  "atletico",
  "club",
  "deportivo",
  "deportes",
  "sportif",
  "sport",
  "sports",
  "de",
  "del",
  "la",
  "le",
  "el",
  "al",
  "las",
  "los",
  "os",
  "as",
  "the",
  "and",
  "y",
  "e",
  "di",
  "da",
  "do",
  "dos",
  "van",
  "von",
]);

/**
 * Generic affixes denoting the club type. Dropped during name comparison.
 * Deliberately kept short; aggressive stripping produces wrong matches.
 */
export const GENERIC_TOKENS = new Set([
  "fc",
  "cf",
  "sk",
  "ac",
  "sc",
  "cd",
  "ud",
  "if",
  "bk",
  "fk",
  "sv",
  "vfl",
  "vfb",
  "ss",
  "ca",
  "ce",
  "ec",
  "aa",
  "cr",
  "afc",
  "cfc",
  "hc",
  "hk",
  "kh",
  "mhc",
  "mhk",
  "jk",
  "us",
  "ssd",
  "asd",
  "nk",
  "rk",
  // "as": AS Monaco / Monaco, AS Cannes / Cannes -- in the real data some
  // of the three sites write this prefix and some do not.
  "as",
  "cs",
  "cp",
  "sv",
  "rc",
  "cda",
  "club",
  // Slavic hockey/football club prefixes: the rest of the HC/HK/KH/MHK family.
  "skp",
  "ohk",
  "mhc",
  "shk",
  "bc",
  "kk",
  "rk",
  "dvsc",
]);

/**
 * Affixes that count as generic ONLY IN CERTAIN SPORTS.
 *
 * "Rugby" denotes the type in a rugby club's name ("Montpellier Herault
 * Rugby" / "Montpellier Herault RC") but can be distinctive in football.
 */
export const SPORT_GENERIC_TOKENS = new Map([
  ["RAGBI", new Set(["rugby", "rc"])],
  ["BUZ_HOKEYI", new Set(["hokej", "hockey"])],
  ["BASKETBOL", new Set(["basket", "basketball", "bc"])],
]);

/** The sports where a US city abbreviation may be expanded.
 * To avoid the "La Plata" -> "Los Angeles Plata" disaster, city
 * abbreviations are expanded ONLY in these sports. */
/**
 * INDIVIDUAL sports.
 *
 * The league qualifier check (Women / U21 / Reserve) exists for CLUB
 * sports: a club's men's, women's and U19 sides carry THE SAME NAME, and
 * the only thing telling them apart is the league's qualifier.
 *
 * Individual sports carry no such risk -- the athlete's name is already
 * unique. Tournament naming, on the other hand, is wildly inconsistent
 * ("ITF W15 Constanta" vs "WTT Women - Constanta - Clay"), so applying the
 * check here only threw away correct matches.
 */
export const INDIVIDUAL_SPORTS = new Set([
  "TENIS",
  "MASA_TENISI",
  "BOKS",
  "MMA",
  "SATRANC",
  "DART",
  "SNOOKER",
  "GOLF",
  "BISIKLET",
  "SUMO",
  "KAYAK",
  "BIATLON",
]);

export const US_LEAGUE_SPORTS = new Set([
  "BASKETBOL",
  "AMERIKAN_FUTBOLU",
  "BEYZBOL",
  "BUZ_HOKEYI",
]);
