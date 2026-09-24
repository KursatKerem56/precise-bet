/**
 * FUZZY COMPARISON
 *
 * The MOST EXPENSIVE and LAST step of the pipeline. By the time candidates
 * reach here, candidates.js has already cut their number to ~4%.
 */

import { tokenize } from "./text.js";
import { WEAK_TOKENS } from "./config.js";

/** Levenshtein (edit) distance - plain JS, single row buffer. */
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

  // If the length difference alone makes the threshold impossible, do not
  // run Levenshtein at all: |len(a)-len(b)| is already a lower bound on the
  // distance.
  const lower = Math.abs(a.length - b.length);
  if ((1 - lower / maxLen) * 100 <= 0) return 0;

  return Math.max(0, 1 - levenshtein(a, b) / maxLen) * 100;
}

const tokenSort = (t) => tokenize(t).sort().join(" ");

const isPrefixAbbrev = (short, long) =>
  short.length >= 1 && short.length < long.length && long.startsWith(short);

/**
 * Word-order insensitive overlap ratio.
 * "Ferro, Fiona" ~ "Fiona Ferro", "Recek D / Siniakov D" ~ "D. Recek / D. Siniakov"
 *
 * Weak words ("City", "United", "Real") score HALF a point, so that
 * "Manchester City" and "Leicester City" do not look close just because they
 * share "City".
 */
function tokenOverlapRatio(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;

  const used = new Array(tb.length).fill(false);
  let score = 0;

  for (const x of ta) {
    // An exact match is looked for first; it takes priority over an
    // abbreviation. That keeps two words starting with the same letter from
    // being paired up wrongly.
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

  // In the denominator weak words count as HALF, while matched tokens count
  // in FULL. So:
  //   - "E. Braunschweig" ~ "Eintracht Braunschweig": both matched, the
  //     denominator is 2 -> 100% (a weak token does not punish a match)
  //   - "Manchester City" ~ "Leicester City": only "city" matches for 1
  //     point, denominator max(1.5, 1.5) -> 66% (a weak word alone does not
  //     produce closeness)
  const weigh = (tokens) => {
    let total = 0;
    for (const t of tokens) total += WEAK_TOKENS.has(t) ? 0.5 : 1;
    return total;
  };

  const denom = Math.max(weigh(ta), weigh(tb));
  return denom === 0 ? 0 : Math.min(100, (100 * score) / denom);
}

/**
 * ACRONYM MATCHING  ("QPR" ~ "Queens Park Rangers")
 *
 * CAREFUL - this function used to be a serious source of wrong matches: any
 * 2 letter token scored 100% as soon as it equalled the other side's
 * initials. In real data these matched at 100%:
 *
 *   "HC Kosice"        <-> "HK Poprad"        ("hc" -> initials h,k)
 *   "CE Gramadense RS" <-> "Criciuma EC"      ("ce" -> initials c,e)
 *
 * Both were completely different clubs. The rule was therefore tightened:
 * THE SHORT SIDE MUST BE A SINGLE TOKEN and must cover the initials of ALL
 * the long side's tokens. That preserves genuine acronyms such as
 * "QPR"/"IPK"/"KTP"/"TOGB" while eliminating the two disasters above.
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

/** Memoise repeated score computations. The same pair of names comes up
 * again and again in the candidate pool. */
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

  // Prevent unbounded growth; in practice this limit is never reached.
  if (ratioCache.size < RATIO_CACHE_LIMIT) ratioCache.set(key, value);

  return value;
}

/** Clears the cache, for tests/diagnostics. */
export const clearSimilarityCache = () => ratioCache.clear();

export { levenshtein, charRatio, tokenOverlapRatio, acronymRatio, tokenSort };
