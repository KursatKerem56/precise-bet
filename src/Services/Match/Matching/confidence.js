/**
 * MATCH COMPARISON AND CONFIDENCE SCORE
 *
 * The signals from the layers are not averaged blindly. The distinction is:
 *
 *   HARD CONSTRAINT (eliminates)         SOFT SIGNAL (moves the score)
 *   --------------------------------     ----------------------------
 *   a different sport                    fuzzy team similarity
 *   a reliably different canonical league  missing country information
 *   mismatched team qualifiers           a small time difference
 *   mismatched league qualifiers         a league abbreviation
 *   an impossible date/time gap          punctuation differences
 *
 * A high team similarity never matches games from DIFFERENT LEAGUES.
 */

import { compareTeams, matchTeamQualifiers } from "./team.js";
import { compareLeagues } from "./league.js";
import { compareMatchTimes } from "./datetime.js";
import { MATCH_CONFIG, LEAGUE_QUALIFIER_CLASS } from "./config.js";

/** The union of the qualifier CLASSES declared by two leagues. */
function leagueDeclaredClasses(...leagues) {
  const classes = new Set();

  for (const league of leagues) {
    for (const q of league?.quals ?? []) {
      const cls = LEAGUE_QUALIFIER_CLASS.get(q);
      if (cls) classes.add(cls);
    }
  }

  return classes.size ? classes : null;
}

export const MATCH_RESULT = {
  MATCH: "match",
  POSSIBLE: "possible_match",
  NONE: "no_match",
};

/**
 * Compares two matches.
 *
 * The pipeline order is deliberate: the cheapest and most certain
 * eliminations run first and the expensive fuzzy comparison is left last.
 *
 * @returns {{
 *   ok: boolean, decision: string, confidence: number,
 *   teamScore: number, leagueScore: number, flipped: boolean,
 *   time: object, reason?: string
 * }}
 */
export function compareMatches(a, b, options = {}) {
  const teamThreshold = options.teamThreshold ?? MATCH_CONFIG.teamThreshold;

  const reject = (reason) => ({
    ok: false,
    decision: MATCH_RESULT.NONE,
    confidence: 0,
    teamScore: 0,
    leagueScore: 0,
    flipped: false,
    time: null,
    reason,
  });

  // --- 1) SPORT (hard) --------------------------------------------------
  if (a.sport !== b.sport) return reject("sport-mismatch");

  // --- 2) LEAGUE (hard reject + soft score) ----------------------------
  // The league qualifier is evaluated together with the TEAM qualifiers;
  // one site may say "NWSL, Women" while another says just "NWSL" and puts
  // the women's marker in the team name.
  const league = compareLeagues(a.leagueInfo, b.leagueInfo, {
    sport: a.sport,
    teamQualifiersA: matchTeamQualifiers(a),
    teamQualifiersB: matchTeamQualifiers(b),
  });
  if (league.hardReject) return reject(league.reason);

  if (
    options.requireLeague &&
    league.score < (options.leagueThreshold ?? MATCH_CONFIG.leagueThreshold)
  ) {
    return reject("league-below-threshold");
  }

  // --- 3) DATE / TIME (hard) -------------------------------------------
  // Two records on different days can only be the same match when a
  // reasonable midnight shift explains the gap.
  const time = compareMatchTimes(a, b, options);
  if (!time.plausible) return reject("implausible-time-gap");

  // --- 4) TEAM (hard qualifiers + soft fuzzy) --------------------------
  // When the league already declares a category (a women's league, a U19
  // league), that category is NOT looked for in the team name: one site
  // says "Charlton Athletic" while another says "Charlton Athletic (Wom)",
  // but both are in the same women's league, so the marker is redundant.
  const ignoreQualifiers = leagueDeclaredClasses(a.leagueInfo, b.leagueInfo);
  const teamOptions = { sport: a.sport, ignoreQualifiers };

  const homeHome = compareTeams(a.home, b.home, teamOptions);
  const awayAway = compareTeams(a.away, b.away, teamOptions);

  const straight = (homeHome.score + awayAway.score) / 2;
  const straightOk =
    homeHome.score >= teamThreshold && awayAway.score >= teamThreshold;

  let teamScore = straight;
  let flipped = false;
  let ok = straightOk;
  let stages = [homeHome.stage, awayAway.stage];

  // The flipped (home/away swapped) ordering is tried ONLY when the
  // straight one does not hold. In real data only 1 of 2068 matches is
  // flipped; doing twice the work for every pair up front was pointless.
  if (!straightOk) {
    const homeAway = compareTeams(a.home, b.away, teamOptions);
    const awayHome = compareTeams(a.away, b.home, teamOptions);

    const cross = (homeAway.score + awayHome.score) / 2;
    const crossOk =
      homeAway.score >= teamThreshold && awayHome.score >= teamThreshold;

    if (crossOk || cross > straight) {
      teamScore = cross;
      flipped = true;
      ok = crossOk;
      stages = [homeAway.stage, awayHome.stage];
    }
  }

  if (!ok) {
    return {
      ...reject("team-below-threshold"),
      teamScore,
      leagueScore: league.score,
      flipped,
    };
  }

  // --- 5) If the league names differ entirely, the team score must be very
  //        high ---------------------------------------------------------
  // (This check used to read two fields that were undefined in DEFAULTS and
  // silently never ran.)
  const lowLeague = options.lowLeagueScore ?? MATCH_CONFIG.lowLeagueScore;
  const teamWhenLow =
    options.teamScoreWhenLeagueLow ?? MATCH_CONFIG.teamScoreWhenLeagueLow;

  if (league.score < lowLeague && teamScore < teamWhenLow) {
    return {
      ...reject("low-league-weak-team"),
      teamScore,
      leagueScore: league.score,
      flipped,
    };
  }

  // --- 6) Confidence score ---------------------------------------------
  const confidence = calculateMatchConfidence({
    teamScore,
    teamStages: stages,
    league,
    time,
  });

  return {
    ok: true,
    decision:
      confidence >= MATCH_CONFIG.highConfidence
        ? MATCH_RESULT.MATCH
        : confidence >= MATCH_CONFIG.possibleConfidence
          ? MATCH_RESULT.POSSIBLE
          : MATCH_RESULT.NONE,
    confidence,
    teamScore,
    leagueScore: league.score,
    flipped,
    time,
  };
}

/**
 * Reduces the layer signals to a single 0-1 confidence score.
 *
 * The team match carries the decisive weight; the league and the time are
 * SUPPORTING signals (their absence is penalised but never decides on its
 * own).
 */
export function calculateMatchConfidence({
  teamScore,
  teamStages,
  league,
  time,
}) {
  // Team: 0-100 -> 0-1; anything below the threshold is already eliminated.
  let confidence = teamScore / 100;

  // A deterministic resolution (exact or alias) is more reliable than fuzzy.
  const deterministic = teamStages.every((s) => s === "exact" || s === "alias");
  if (deterministic) confidence = Math.min(1, confidence + 0.03);

  // The league signal
  if (league.stage === "alias" || league.stage === "exact-with-country") {
    confidence = Math.min(1, confidence + 0.05);
  } else if (league.stage === "exact") {
    confidence = Math.min(1, confidence + 0.02);
  } else if (league.score < MATCH_CONFIG.lowLeagueScore) {
    confidence -= 0.08;
  }

  // The time signal: a matching time raises confidence, a large gap lowers it.
  if (time?.comparable) {
    const diff = Math.abs(time.diffMinutes);
    if (diff <= 5) confidence = Math.min(1, confidence + 0.04);
    else if (diff > 180) confidence -= 0.05;
  } else {
    // No time means one distinguishing signal is missing.
    confidence -= 0.03;
  }

  return Math.max(0, Math.min(1, confidence));
}
