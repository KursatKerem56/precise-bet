/**
 * BULANIK (FUZZY) KARSILASTIRMA
 *
 * Pipeline'in EN PAHALI ve EN SON adimi. Buraya gelen aday sayisi
 * candidates.js tarafindan zaten ~%4'e indirilmis oluyor.
 */

import { tokenize } from "./text.js";
import { WEAK_TOKENS } from "./config.js";

/** Levenshtein (duzenleme) mesafesi - saf JS, tek satir buffer. */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function charRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;

  // Uzunluk farki tek basina esigi imkansiz kiliyorsa Levenshtein'i hic
  // calistirma: |len(a)-len(b)| zaten mesafenin alt siniri.
  const lower = Math.abs(a.length - b.length);
  if ((1 - lower / maxLen) * 100 <= 0) return 0;

  return Math.max(0, 1 - levenshtein(a, b) / maxLen) * 100;
}

const tokenSort = (t) => tokenize(t).sort().join(" ");

const isPrefixAbbrev = (short, long) =>
  short.length >= 1 && short.length < long.length && long.startsWith(short);

/**
 * Kelime sirasina duyarsiz ortusme orani.
 * "Ferro, Fiona" ~ "Fiona Ferro", "Recek D / Siniakov D" ~ "D. Recek / D. Siniakov"
 *
 * Zayif kelimeler ("City", "United", "Real") YARIM puan alir: "Manchester
 * City" ile "Leicester City" sirf "City" ortak diye yakin cikmasin.
 */
function tokenOverlapRatio(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;

  const used = new Array(tb.length).fill(false);
  let score = 0;

  for (const x of ta) {
    // Once birebir eslesme aranir; kisaltmaya gore onceliklidir. Boylece
    // ayni harfle baslayan iki kelime birbirine yanlis atanmaz.
    let exact = -1;
    for (let j = 0; j < tb.length; j++) {
      if (!used[j] && x === tb[j]) {
        exact = j;
        break;
      }
    }
    if (exact >= 0) {
      used[exact] = true;
      score += 1;
      continue;
    }

    for (let j = 0; j < tb.length; j++) {
      if (used[j]) continue;
      if (isPrefixAbbrev(x, tb[j]) || isPrefixAbbrev(tb[j], x)) {
        used[j] = true;
        score += 1;
        break;
      }
    }
  }

  // Paydada zayif kelimeler YARIM sayilir; eslesen token'lar ise TAM.
  // Boylece:
  //   - "E. Braunschweig" ~ "Eintracht Braunschweig": ikisi de eslesti,
  //     payda 2 -> %100 (zayif token esleseni cezalandirmaz)
  //   - "Manchester City" ~ "Leicester City": yalnizca "city" esleserek
  //     1 puan, payda max(1.5, 1.5) -> %66 (zayif kelime tek basina
  //     yakinlik uretmez)
  const weigh = (tokens) => {
    let total = 0;
    for (const t of tokens) total += WEAK_TOKENS.has(t) ? 0.5 : 1;
    return total;
  };

  const denom = Math.max(weigh(ta), weigh(tb));
  return denom === 0 ? 0 : Math.min(100, (100 * score) / denom);
}

/**
 * AKRONIM ESLESMESI  ("QPR" ~ "Queens Park Rangers")
 *
 * DIKKAT - bu fonksiyon eskiden ciddi bir yanlis eslesme kaynagiydi:
 * herhangi bir 2 harfli token, karsi tarafin bas harfleriyle ayni olunca
 * %100 veriyordu. Gercek veride sunlar %100 eslesmisti:
 *
 *   "HC Kosice"        <-> "HK Poprad"        ("hc" -> h,k bas harfleri)
 *   "CE Gramadense RS" <-> "Criciuma EC"      ("ce" -> c,e bas harfleri)
 *
 * Ikisi de tamamen farkli kuluplerdi. Bu yuzden kural siklastirildi:
 * KISA TARAF TEK TOKEN OLMALI ve UZUN TARAFIN TUM token'larinin bas
 * harflerini kapsamali. Boylece "QPR"/"IPK"/"KTP"/"TOGB" gibi gercek
 * akronimler korunur, yukaridaki iki felaket elenir.
 */
function acronymRatio(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);

  const dir = (shortT, longT) => {
    if (shortT.length !== 1 || longT.length < 2) return 0;

    const acronym = shortT[0];
    if (acronym.length < 2) return 0;

    const initials = longT.map((t) => t[0]).join("");
    return acronym === initials ? 100 : 0;
  };

  return Math.max(dir(ta, tb), dir(tb, ta));
}

/** Tekrarlanan skor hesaplarini sakla. Ayni ad cifti aday havuzunda
 * defalarca karsiya cikiyor. */
const ratioCache = new Map();
const RATIO_CACHE_LIMIT = 200_000;

export function similarityRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;

  const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  const hit = ratioCache.get(key);
  if (hit !== undefined) return hit;

  const value = Math.max(
    charRatio(a, b),
    charRatio(tokenSort(a), tokenSort(b)),
    tokenOverlapRatio(a, b),
    acronymRatio(a, b)
  );

  // Sinirsiz buyumeyi engelle; pratikte bu sinira ulasilmiyor.
  if (ratioCache.size < RATIO_CACHE_LIMIT) ratioCache.set(key, value);

  return value;
}

/** Test/teshis icin cache'i temizler. */
export const clearSimilarityCache = () => ratioCache.clear();

export { levenshtein, charRatio, tokenOverlapRatio, acronymRatio, tokenSort };
