/**
 * METIN NORMALIZASYONU
 *
 * Ayni ad her karsilastirmada yeniden normalize edilmesin diye butun
 * donusumler cache'li. Gercek veride ~5000 mac / ~9000 farkli takim adi
 * var ama aday daraltma sonrasi ayni ad yuzlerce kez karsiya cikiyor;
 * cache bu tekrarlari tek hesaba indiriyor.
 */

import { GENERIC_TOKENS, TEAM_QUALIFIERS } from "./config.js";

const TR_MAP = {
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ı: "i",
  I: "i",
  İ: "i",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
};

/** Tekrarlanan donusumler icin basit hafiza. Girdi kumesi sinirli
 * (site basina birkac bin ad) oldugu icin sinirsiz buyume riski yok. */
const makeCache = () => new Map();

const foldCache = makeCache();

/**
 * Kucuk harfe cevirir, Turkce karakterleri katlar, diger aksanlari
 * sadelestirir, noktalamayi atar, bosluklari teke indirir.
 *
 * Ayrica "&" -> " and " (Texas A&M Aggies <-> Texas AM Aggies) ve
 * kesme/tire varyasyonlari burada tekillestirilir.
 */
export function foldText(text) {
  if (!text) return "";

  const key = String(text);
  const hit = foldCache.get(key);
  if (hit !== undefined) return hit;

  let t = key.trim().toLowerCase();
  t = t.replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch);
  t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  // "A&M" -> "AM" (Texas A&M Aggies <-> Texas AM Aggies). Bosluklu "&"
  // zaten cift bosluga donusup asagida teke iniyor.
  t = t.replace(/&/g, "");
  t = t.replace(/[.\-'’`]/g, " ");
  t = t.replace(/[^a-z0-9\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();

  foldCache.set(key, t);
  return t;
}

/** Bosluga gore ayirir; bos token birakmaz. */
export const tokenize = (folded) => folded.split(" ").filter(Boolean);

/**
 * TURKCE SEHIR/ULKE EXONIMLERI (token seviyesinde)
 *
 * betist bir kismi Turkce yaziyor: "Bayern Münih", "Spartak Moskova",
 * "CSKA Sofya", "Sparta Prag". Bunlari tek tek takim alias'i yapmak yerine
 * TOKEN olarak cevirmek daha genel: tek kayit butun kulupleri kapsiyor.
 */
const EXONYM_TOKENS = new Map(
  Object.entries({
    munih: "munich",
    moskova: "moscow",
    sofya: "sofia",
    prag: "prague",
    praha: "prague",
    viyana: "wien",
    vien: "wien",
    atina: "athens",
    kopenhag: "copenhagen",
    lizbon: "lisbon",
    brüksel: "brussels",
    bruksel: "brussels",
    kiev: "kyiv",
    belgrad: "belgrade",
    bukres: "bucharest",
    varsova: "warsaw",
    milano: "milan",
    roma: "rome",
    torino: "turin",
    napoli: "naples",
    // Sadece "Saint/Sankt" -> "st". "Santa"/"Sao" BILINCLI olarak disarida:
    // bunlar ayri adlar ve katlanirsa farkli kulupler birbirine karisir.
    saint: "st",
    sankt: "st",
  })
);

/** Bir token'i bilinen exonim karsiligina cevirir. */
export const foldExonym = (token) => EXONYM_TOKENS.get(token) ?? token;

/**
 * Sezon bilgisi ("2026", "2026/2027", "2026-27") foldText'ten ONCE
 * temizlenir, cunku "/" sonradan bosluga donusup "27" gibi artik birakir.
 */
const SEASON_RE = /\b(19|20)\d{2}([/-](19|20)?\d{2})?\b/g;

export const stripSeason = (name) => String(name ?? "").replace(SEASON_RE, " ");

/**
 * Bir adi "cekirdek ad" ve "niteleyiciler" olarak ayirir.
 *
 * Sondaki tek harf ("... B") sadece KARSI TARAFTA tek harfli token YOKSA
 * niteleyici sayilir. Aksi halde tenisteki "Recek D" / "D. Recek" bicimini
 * yanlislikla farkli takim sanardik.
 */
export function splitQualifiers(folded, otherFolded, ignore = null) {
  const tokens = tokenize(folded);
  const otherTokens = tokenize(otherFolded);

  const hasSingle = (list) => list.some((t) => t.length === 1);
  const singleLettersAreInitials = hasSingle(tokens) && hasSingle(otherTokens);

  const quals = new Set();
  const core = [];

  tokens.forEach((token, index) => {
    if (TEAM_QUALIFIERS.has(token)) {
      const canon = normalizeQualifier(token);
      // Ligin kendisi zaten bu kategoriyi bildiriyorsa (ornegin kadinlar
      // ligi) takim adindaki isaret gereksiz tekrardir; bir site yazip
      // digeri yazmayinca farkli takim sanilmamali.
      if (!ignore?.has(canon)) quals.add(canon);
      return;
    }

    const isLast = index === tokens.length - 1;

    if (
      !singleLettersAreInitials &&
      isLast &&
      token.length === 1 &&
      tokens.length > 1
    ) {
      // "(W)" kadin takimlarinin standart isareti; "Wom"/"Women" ile ayni
      // seyi soyluyor. Ayni anahtara indirgenmezse "India A (W)" ile
      // "India A (Wom)" farkli takim sanilirdi.
      const canon = token === "w" ? "women" : token;
      if (!ignore?.has(canon)) quals.add(canon);
      return;
    }

    core.push(token);
  });

  return { core: core.join(" ") || folded, quals };
}

/** Ayni niteleyicinin farkli yazimlarini tek anahtara indirger:
 * "women" / "kadin" / "femenino" hepsi ayni seyi soyluyor. */
const QUALIFIER_CANON = new Map(
  Object.entries({
    womens: "women",
    wom: "women",
    kadin: "women",
    kadinlar: "women",
    ladies: "women",
    femenino: "women",
    feminin: "women",
    feminine: "women",
    fem: "women",
    reserves: "reserve",
    rezerv: "reserve",
    res: "reserve",
    ii: "reserve",
    juniors: "youth",
    junior: "youth",
    jr: "youth",
    genclik: "youth",
    altyapi: "youth",
    akademi: "academy",
    amator: "amateur",
  })
);

export const normalizeQualifier = (token) =>
  QUALIFIER_CANON.get(token) ?? token;

/** Iki niteleyici kumesi ayni mi? */
export function sameQualifiers(a, b) {
  if (a.size !== b.size) return false;
  for (const q of a) if (!b.has(q)) return false;
  return true;
}

/** Jenerik kulup eklerini ("fc", "sc", "hc" ...) atar. */
export const stripGeneric = (tokens) =>
  tokens.filter((t) => !GENERIC_TOKENS.has(t));
