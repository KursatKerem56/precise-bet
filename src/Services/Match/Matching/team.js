/**
 * TAKIM ESLESTIRME PIPELINE'I
 *
 *   Asama 1 : Normalize edilmis adlar birebir ayni      -> 100
 *   Asama 2 : Ikisi de AYNI kanonik takima cozuluyor    -> 100 (alias)
 *   Asama 3 : Kontrollu bulanik karsilastirma           -> 0-100
 *
 * Her asamadan once NITELEYICI kontrolu var: "Barcelona" ile "Barcelona B",
 * "Barcelona Women" veya "Barcelona U19" ayni takim DEGILDIR ve isim ne
 * kadar benzerse benzesin eslestirilmez (hard constraint).
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
 * ABD liglerinde gecen sehir kisaltmalari.
 *
 * DIKKAT - bunlar eskiden HER sporda aciliyordu ve gercek veride 49 takim
 * adini bozuyordu:
 *
 *   "Deportivo La Coruna"     -> "deportivo LOS ANGELES coruna"
 *   "Gimnasia La Plata"       -> "gimnasia LOS ANGELES plata"
 *   "Sepsi Sf. Gheorghe"      -> "sepsi SAN FRANCISCO gheorghe"
 *
 * Artik yalnizca ABD ligi olan sporlarda VE ham metinde token BUYUK HARF
 * yazilmissa aciliyor ("LA Galaxy" evet, "La Plata" hayir).
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

/** Ham adda BUYUK HARF yazilmis token'larin kumesi. */
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

/** normalize sonuclari icin cache: "sport\0ad" -> normalize edilmis ad. */
const normalizeCache = new Map();

/**
 * Ardisik tek harfli token'lari tek bir kisaltmaya birlestirir.
 *
 *   "C A Antoniano"    -> ["ca", "antoniano"]   ("ca" sonra jenerik olarak atilir)
 *   "L. A. Galaxy"     -> ["la", "galaxy"]
 *   "N. E. Revolution" -> ["ne", "revolution"]
 *
 * Siteler ayni kisaltmayi bitisik ya da noktali yaziyor; birlestirmeden
 * "c a antoniano" ile "ca antoniano" farkli token sayisina dusuyor ve
 * benzerlik gereksiz yere azaliyordu.
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
 * Takim adini karsilastirmaya hazir bicime indirger.
 *
 * @param {string} name
 * @param {{ sport?: string }} [options] sport verilirse ABD sehir
 *        kisaltmalari yalnizca ilgili sporlarda acilir.
 */
export function normalizeTeamName(name, options = {}) {
  const sport = options.sport ?? null;
  const cacheKey = `${sport ?? ""}\u0000${name ?? ""}`;

  const hit = normalizeCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const folded = foldText(name);

  // Asama 2'nin girdisi: alias tablosunda tam ad karsiligi var mi?
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
 * Bir adin kanonik takim kimligini dondurur (varsa).
 * Niteleyiciler kimligin PARCASIDIR: "Barcelona B" ile "Barcelona" ayni
 * kimlige cozulmemeli.
 */
export function resolveTeam(name, options = {}) {
  const folded = foldText(name);
  const direct = resolveTeamAlias(folded);
  if (direct) return direct;

  // Niteleyicileri ayirip cekirdek adi da dene: "Manchester Utd U21"
  // cekirdegi "Manchester Utd" -> manchester_united, niteleyici u21 ayri
  // tasinir ve karsilastirmada zaten ayrica kontrol edilir.
  const { core } = splitQualifiers(folded, "");
  if (core !== folded) {
    const viaCore = resolveTeamAlias(core);
    if (viaCore) return viaCore;
  }

  return resolveTeamAlias(normalizeTeamName(name, options));
}

/**
 * Bir adin "guclu" (ayirt edici) token'i var mi?
 *
 * "City", "United", "Real", "Sporting" tek baslarina kimlik tasimaz.
 * Iki ad SADECE zayif kelimelerde ortusuyorsa eslesme sayilmaz.
 */
const hasStrongToken = (normalized) =>
  tokenize(normalized).some((t) => !WEAK_TOKENS.has(t));

/** Iki normalize adin paylastigi token sayilari (guclu / zayif ayri). */
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
 * Iki takim adini karsilastirir.
 *
 * @returns {{ score: number, stage: "exact"|"alias"|"fuzzy"|"rejected", reason?: string }}
 */
export function compareTeams(a, b, options = {}) {
  const na = normalizeTeamName(a, options);
  const nb = normalizeTeamName(b, options);

  if (!na || !nb) return { score: 0, stage: "rejected", reason: "empty" };

  // --- HARD CONSTRAINT: niteleyiciler ---------------------------------
  // Karsilastirma ham (fold edilmis) ad uzerinden yapilir; normalize
  // asamasi jenerik ekleri atarken niteleyiciyi de yiyebilir.
  const fa = foldText(a);
  const fb = foldText(b);
  const ignore = options.ignoreQualifiers ?? null;
  const pa = splitQualifiers(fa, fb, ignore);
  const pb = splitQualifiers(fb, fa, ignore);

  if (!sameQualifiers(pa.quals, pb.quals)) {
    return { score: 0, stage: "rejected", reason: "qualifier-mismatch" };
  }

  // --- Asama 1: birebir ------------------------------------------------
  if (na === nb) return { score: 100, stage: "exact" };

  // --- Asama 2: alias --------------------------------------------------
  const ra = resolveTeam(a, options);
  const rb = resolveTeam(b, options);
  if (ra && rb && ra.id === rb.id) {
    return { score: MATCH_CONFIG.teamAliasScore, stage: "alias" };
  }

  // --- Asama 3: kontrollu bulanik --------------------------------------
  const score = similarityRatio(
    normalizeTeamName(pa.core, options),
    normalizeTeamName(pb.core, options)
  );

  // Iki ad da zayif kelimelerden ibaretse ("City" vs "City") karar verme.
  if (!hasStrongToken(na) && !hasStrongToken(nb)) {
    return { score: 0, stage: "rejected", reason: "no-strong-token" };
  }

  // "Manchester City" / "Leicester City" korumasi: ortak olan TEK sey
  // zayif bir kelimeyse ve guclu token'lar hic ortusmuyorsa eslesme
  // kabul edilmez.
  //
  // DIKKAT: kosul "paylasilan zayif token VAR" diye baglanmak ZORUNDA.
  // Aksi halde hicbir token'i ortak olmayan ama ayni adin farkli
  // yazimi olan isimler de elenirdi:
  //   "Baracaldo" / "Barakaldo", "Nordsjalland" / "Nordsjaelland"
  const shared = sharedTokens(na, nb);

  if (
    score >= MATCH_CONFIG.teamThreshold &&
    shared.strong === 0 &&
    shared.weak > 0
  ) {
    // Zayif kelimeleri atip GERIYE KALANI karsilastir. "Manchester" ile
    // "Leicester" birbirine benzemez -> gercekten sadece "City" ortak,
    // eslesme reddedilir. Ama "Salfrod" ile "Salford" benzer -> bu bir
    // yazim hatasi varyanti, reddedilmemeli.
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
 * Bir macin takim adlarinda gecen niteleyicilerin birlesimi.
 *
 * Lig niteleyicisiyle BIRLIKTE degerlendirilir: bir site ligi
 * "USA - NWSL, Women" diye yazarken digeri "United States - NWSL" diyor
 * ama iki tarafta da takimlar "(W)" tasiyor. Yalnizca lig adina bakan bir
 * kontrol bu 24 dogru eslesmeyi eliyordu.
 *
 * Acik yazilmis ekler (women / u21 / reserve ...) ve kadin takimlarinin
 * standart "(W)" isareti toplanir. Tek harfli DIGER token'lar (tenisteki
 * "Recek D" gibi isim bas harfleri) niteleyici SAYILMAZ.
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

/** Geriye donuk uyumlu sade skor (eski `teamSimilarity` imzasi). */
export const teamSimilarity = (a, b, options) =>
  compareTeams(a, b, options).score;

/** Test/teshis icin normalize cache'ini temizler. */
export const clearTeamCache = () => normalizeCache.clear();

export { CITY_ABBREVIATIONS };
