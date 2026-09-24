/**
 * MAC KARSILASTIRMASI VE GUVEN SKORU
 *
 * Katmanlardan gelen sinyaller KORU KORUNE ortalanmaz. Ayrim su:
 *
 *   HARD CONSTRAINT (dogrudan eler)      SOFT SIGNAL (skoru etkiler)
 *   --------------------------------     ----------------------------
 *   farkli spor                          bulanik takim benzerligi
 *   guvenilir farkli kanonik lig         eksik ulke bilgisi
 *   uyumsuz takim niteleyicisi           kucuk saat farki
 *   uyumsuz lig niteleyicisi             lig kisaltmasi
 *   imkansiz tarih/saat farki            noktalama farklari
 *
 * Takim benzerligi yuksek diye FARKLI LIGLERDEKI maclar eslestirilmez.
 */

import { compareTeams, matchTeamQualifiers } from "./team.js";
import { compareLeagues } from "./league.js";
import { compareMatchTimes } from "./datetime.js";
import { MATCH_CONFIG, LEAGUE_QUALIFIER_CLASS } from "./config.js";

/** Iki ligin bildirdigi niteleyici SINIFLARININ birlesimi. */
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
 * Iki maci karsilastirir.
 *
 * Pipeline sirasi bilincli: en ucuz ve en kesin elemeler once yapilir,
 * pahali bulanik karsilastirma en sona birakilir.
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

  // --- 1) SPOR (hard) ---------------------------------------------------
  if (a.sport !== b.sport) return reject("sport-mismatch");

  // --- 2) LIG (hard reject + soft skor) --------------------------------
  // Lig niteleyicisi TAKIM niteleyicileriyle birlikte degerlendirilir;
  // bir site "NWSL, Women" derken digeri sadece "NWSL" deyip kadin
  // isaretini takim adina koyabiliyor.
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

  // --- 3) TARIH / SAAT (hard) ------------------------------------------
  // Farkli gunlerdeki iki kayit ancak makul bir gece yarisi kaymasiyla
  // aciklanabiliyorsa ayni mac olabilir.
  const time = compareMatchTimes(a, b, options);
  if (!time.plausible) return reject("implausible-time-gap");

  // --- 4) TAKIM (hard niteleyici + soft bulanik) ------------------------
  // Lig zaten bir kategori bildiriyorsa (kadinlar ligi, U19 ligi) o
  // kategori takim adinda ARANMAZ: bir site "Charlton Athletic" derken
  // digeri "Charlton Athletic (Wom)" diyor ama ikisi de ayni kadinlar
  // ligindeler, yani isaret gereksiz tekrar.
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

  // Ters (ev/deplasman yer degistirmis) siralama YALNIZCA duz siralama
  // tutmayinca denenir. Gercek veride 2068 eslesmenin sadece 1'i ters
  // sirali; her cift icin bastan iki kat is yapmak gereksizdi.
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

  // --- 5) Lig adi tamamen farkliysa takim skoru cok yuksek olmali -------
  // (Bu kontrol eskiden DEFAULTS'ta tanimsiz iki alana bakiyordu ve
  // sessizce HIC calismiyordu.)
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

  // --- 6) Guven skoru ---------------------------------------------------
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
 * Katman sinyallerini tek bir 0-1 guven skoruna indirger.
 *
 * Takim eslesmesi belirleyici agirliktadir; lig ve saat DESTEKLEYICI
 * sinyallerdir (eksikligi cezalandirilir ama tek basina karar vermez).
 */
export function calculateMatchConfidence({
  teamScore,
  teamStages,
  league,
  time,
}) {
  // Takim: 0-100 -> 0-1, esik altini zaten elenmis kabul ediyoruz.
  let confidence = teamScore / 100;

  // Deterministik cozum (birebir ya da alias) bulaniktan daha guvenilir.
  const deterministic = teamStages.every((s) => s === "exact" || s === "alias");
  if (deterministic) confidence = Math.min(1, confidence + 0.03);

  // Lig sinyali
  if (league.stage === "alias" || league.stage === "exact-with-country") {
    confidence = Math.min(1, confidence + 0.05);
  } else if (league.stage === "exact") {
    confidence = Math.min(1, confidence + 0.02);
  } else if (league.score < MATCH_CONFIG.lowLeagueScore) {
    confidence -= 0.08;
  }

  // Saat sinyali: uyumlu saat guveni artirir, buyuk fark azaltir.
  if (time?.comparable) {
    const diff = Math.abs(time.diffMinutes);
    if (diff <= 5) confidence = Math.min(1, confidence + 0.04);
    else if (diff > 180) confidence -= 0.05;
  } else {
    // Saat yoksa ayirt edici bir sinyal eksik demektir.
    confidence -= 0.03;
  }

  return Math.max(0, Math.min(1, confidence));
}
