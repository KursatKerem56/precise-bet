/**
 * LIG ESLESTIRME PIPELINE'I
 *
 *   Asama 1 : Normalize edilmis lig adlari birebir ayni
 *   Asama 2 : Ikisi de AYNI kanonik lig id'sine cozuluyor (alias)
 *   Asama 3 : Ulke + normalize ad eslesmesi
 *   Asama 4 : Kontrollu bulanik eslesme (sport context ZORUNLU)
 *
 * ---------------------------------------------------------------------------
 * LIG NEDEN KATI (HARD) BIR KOVA ANAHTARI DEGIL
 *
 * Uc site ayni ligi cok farkli yaziyor:
 *
 *   betist : "International Clubs - UEFA Champions League"
 *   mavibet: "Europe - UEFA Champions League - League Stage"
 *   virusbet: "Europe - UEFA Champions League"
 *
 * Gercek veride betist'in 150 futbol liginin neredeyse hicbiri mavibet'te
 * BIREBIR ayni yazilmiyor. Ligi zorunlu kova anahtari yapmak eslesmelerin
 * buyuk kismini kaybettirirdi. Bu yuzden lig:
 *
 *   - GUVENILIR sekilde farkli oldugunda (iki taraf da kanonik lig'e
 *     cozuluyor ve id'ler farkli)            -> HARD REJECT
 *   - Niteleyicileri farkli oldugunda
 *     (Women / U21 / Reserve)                -> HARD REJECT
 *   - Diger her durumda                      -> SOFT SIGNAL (skor)
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

/** Lig adinda sezon/grup/asama gurultusu. */
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

/** Lig adini normalize eder (sezon bilgisi atilir). */
export function normalizeLeagueName(name) {
  const key = String(name ?? "");
  const hit = normalizeCache.get(key);
  if (hit !== undefined) return hit;

  const value = foldText(stripSeason(key));
  normalizeCache.set(key, value);
  return value;
}

/**
 * "Ulke - Lig Adi" anahtarini parcalarina ayirir.
 * Ulke adi alias tablosundan tekillestirilir (Holland -> Netherlands).
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
 * Lig adindaki niteleyicileri ayirir.
 * "Primera Division, Women" -> core "primera division", quals {women}
 * "U20, COSAFA Cup"         -> core "cosafa cup",       quals {u20}
 */
export function splitLeagueQualifiers(foldedName) {
  const quals = new Set();
  const core = [];

  for (const token of tokenize(foldedName)) {
    if (LEAGUE_QUALIFIERS.has(token)) {
      // "womens" ve "women" ayni seyi soyluyor.
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
 * Bir lig anahtarini cozumlenmis hale getirir. Sonuc mac nesnesinde
 * SAKLANIR; her karsilastirmada yeniden hesaplanmaz.
 *
 * @param {string} sportKey  katalog spor anahtari (FUTBOL ...)
 * @param {string} leagueKey "Ulke - Lig Adi"
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
 * Iki cozumlenmis ligi karsilastirir.
 *
 * @returns {{ score: number, stage: string, hardReject: boolean, reason?: string }}
 */
export function compareLeagues(a, b, context = {}) {
  if (!a || !b) return { score: 0, stage: "unknown", hardReject: false };

  // --- HARD CONSTRAINT: niteleyici ------------------------------------
  // "Primera Division" ile "Primera Division, Women" ayri yarismalardir.
  //
  // Kontrol LIG + TAKIM niteleyicilerinin BIRLESIMI uzerinden yapilir.
  // Bir site niteleyiciyi lig adina, digeri takim adina yazabiliyor:
  //   betist : "USA - NWSL, Women"        takimlar "... (w)"
  //   mavibet: "United States - NWSL"     takimlar "... (W)"
  // Ikisi de ayni yarisma; yalnizca lig adina bakmak bunu ayirirdi.
  const effective = (league, teamQuals) => {
    const merged = new Set();
    for (const q of league.quals)
      merged.add(LEAGUE_QUALIFIER_CLASS.get(q) ?? q);
    for (const q of teamQuals ?? [])
      merged.add(LEAGUE_QUALIFIER_CLASS.get(q) ?? q);
    return merged;
  };

  // Bireysel sporlarda bu kontrol uygulanmaz: sporcu adi zaten tekil,
  // turnuva adlandirmasi ise cok tutarsiz.
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

  // --- HARD CONSTRAINT: guvenilir kanonik lig farki --------------------
  // Yalnizca IKI TARAF da guvenle cozulduyse reddederiz; tek tarafli veya
  // dusuk guvenli cozumler yanlis eleme yapabilir.
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

  // --- Asama 2: ayni kanonik lig ---------------------------------------
  if (a.canonicalId && b.canonicalId && a.canonicalId === b.canonicalId) {
    return { score: 100, stage: "alias", hardReject: false };
  }

  // --- HARD CONSTRAINT: farkli ULKE ------------------------------------
  //
  // "England - Premier League" ile "Belarus - Premier League" AYNI LIG
  // DEGILDIR; ortak olan tek sey lig adidir. Ulke bu yuzden kati kisittir.
  //
  // Kisit, alias tablosundaki `regions` listesiyle SINIRLANIR. Ulke
  // alaninda her zaman ulke olmuyor:
  //   - cografi kova : "Europe", "World", "International Clubs"
  //   - spor adi     : "Rugby Union - France Pro D2"   (betist)
  //   - tur adi      : "ATP - Saint Tropez"            (betist)
  //   - ust ulke     : "United Kingdom - Elite League" (mavibet)
  //                    ayni ligi betist "England - Elite League" diyor
  //
  // Bu degerler `regions` olarak isaretli oldugu icin eleme yapmaz.
  // Taninmayan ama GERCEK bir ulke olan degerler (ornegin "Belarus")
  // kisiti normal sekilde uygular -- allowlist kullansaydik tam da
  // korumak istedigimiz durumu kacirirdik.
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

  // --- Asama 1 / 3: birebir (ulke baglamiyla) --------------------------
  if (a.core && a.core === b.core) {
    const sameCountry = a.country && b.country && a.country === b.country;
    return {
      score: 100,
      stage: sameCountry ? "exact-with-country" : "exact",
      hardReject: false,
    };
  }

  // --- Asama 4: kontrollu bulanik --------------------------------------
  const score = similarityRatio(a.core, b.core);
  return { score, stage: "fuzzy", hardReject: false };
}

/** Geriye donuk uyumlu sade skor (eski `leagueSimilarity` imzasi). */
export const leagueSimilarity = (a, b) =>
  similarityRatio(normalizeLeagueName(a), normalizeLeagueName(b));

export const clearLeagueCache = () => normalizeCache.clear();

export { MATCH_CONFIG };
