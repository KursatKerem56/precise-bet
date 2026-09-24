/**
 * TEXT NORMALISATION
 *
 * Every conversion is cached so the same name is not normalised again on
 * every comparison. Real data holds ~5000 matches / ~9000 distinct team
 * names, but after candidate narrowing the same name comes up hundreds of
 * times; the cache collapses those repeats into a single computation.
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

/** A simple memo for repeated conversions. The input set is bounded (a few
 * thousand names per site), so there is no risk of unbounded growth. */
const makeCache = () => new Map();

const foldCache = makeCache();

/**
 * Lowercases, folds Turkish characters, simplifies the other accents, drops
 * punctuation and collapses whitespace.
 *
 * The "&" handling (Texas A&M Aggies <-> Texas AM Aggies) and the
 * apostrophe/dash variants are unified here as well.
 */
export function foldText(text) {
  if (!text) return "";

  const key = String(text);
  const hit = foldCache.get(key);
  if (hit !== undefined) return hit;

  let t = key.trim().toLowerCase();
  t = t.replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch);
  t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  // "A&M" -> "AM" (Texas A&M Aggies <-> Texas AM Aggies). A spaced "&"
  // turns into a double space and is collapsed below anyway.
  t = t.replace(/&/g, "");
  t = t.replace(/[.\-'’`]/g, " ");
  t = t.replace(/[^a-z0-9\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();

  foldCache.set(key, t);
  return t;
}

/** Splits on whitespace; leaves no empty token. */
export const tokenize = (folded) => folded.split(" ").filter(Boolean);

/**
 * TURKISH CITY/COUNTRY EXONYMS (at the token level)
 *
 * betist writes some of them in Turkish: "Bayern Münih", "Spartak Moskova",
 * "CSKA Sofya", "Sparta Prag". Translating them as TOKENS is more general
 * than adding one team alias each: a single entry covers every club.
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
    // Only "Saint/Sankt" -> "st". "Santa"/"Sao" are DELIBERATELY left out:
    // they are separate names and folding them would confuse different clubs.
    saint: "st",
    sankt: "st",
  })
);

/** Converts a token into its known exonym equivalent. */
export const foldExonym = (token) => EXONYM_TOKENS.get(token) ?? token;

/**
 * Season information ("2026", "2026/2027", "2026-27") is stripped BEFORE
 * foldText, because "/" later becomes whitespace and leaves debris like "27".
 */
const SEASON_RE = /\b(19|20)\d{2}([/-](19|20)?\d{2})?\b/g;

export const stripSeason = (name) => String(name ?? "").replace(SEASON_RE, " ");

/**
 * Splits a name into a "core name" and "qualifiers".
 *
 * A trailing single letter ("... B") only counts as a qualifier when the
 * OTHER SIDE has NO single letter token. Otherwise the tennis style "Recek
 * D" / "D. Recek" would wrongly look like two different teams.
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
      // If the league itself already reports this category (a women's
      // league, say), the marker in the team name is redundant; one site
      // writing it and another not must not look like different teams.
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
      // "(W)" is the standard marker for women's teams; it says the same
      // thing as "Wom"/"Women". Without collapsing them onto one key,
      // "India A (W)" and "India A (Wom)" would look like different teams.
      const canon = token === "w" ? "women" : token;
      if (!ignore?.has(canon)) quals.add(canon);
      return;
    }

    core.push(token);
  });

  return { core: core.join(" ") || folded, quals };
}

/** Reduces different spellings of the same qualifier onto one key:
 * "women" / "kadin" / "femenino" all say the same thing. */
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

/** Are the two qualifier sets the same? */
export function sameQualifiers(a, b) {
  if (a.size !== b.size) return false;
  for (const q of a) if (!b.has(q)) return false;
  return true;
}

/** Drops generic club affixes ("fc", "sc", "hc" ...). */
export const stripGeneric = (tokens) =>
  tokens.filter((t) => !GENERIC_TOKENS.has(t));
