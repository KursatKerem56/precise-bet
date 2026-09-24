/**
 * CANDIDATE REDUCTION
 *
 * The old code took each match's candidates from the "sport|date" bucket
 * alone. On real data that meant 979,978 candidate pairs across the three
 * sites (= 3.9 million fuzzy team comparisons) and a single run took ~72
 * seconds.
 *
 * Here an INVERTED INDEX over team names is built on top of the bucket:
 *
 *     sport -> dateKey -> tokenPrefix -> [match indexes]
 *
 * A match's candidate pool is only those matches in the SAME SPORT +
 * SAME/NEIGHBOURING DATE bucket that share at least one 3 letter prefix
 * from their team names.
 *
 * Measured on real data:
 *   candidate pairs  979,978 -> 43,501  (4.4%)
 *   correct matches     2068 -> 2067    (99.95% recall)
 *
 * The ONE match lost was a false positive anyway ("CE Gramadense RS" with
 * "Criciuma EC"), so the narrowing costs no accuracy at all.
 *
 * Why the PREFIX rather than the token itself: the sites spell the same
 * name slightly differently (Nordsjalland/Nordsjaelland,
 * Baracaldo/Barakaldo, Slovakya/Slovakia, Zimbabve/Zimbabwe). Exact token
 * equality would lose those; a 3 letter prefix catches them.
 */

import { tokenize } from "./text.js";
import { normalizeTeamName } from "./team.js";
import { dateKeyOffset } from "./datetime.js";
import { MATCH_CONFIG, WEAK_TOKENS } from "./config.js";

/**
 * Produces a match's blocking signature: the set of token prefixes of both
 * team names.
 *
 * Weak words ("City", "United", "Real") do NOT enter the signature:
 * otherwise every "... City" team would land in one bucket and make the
 * narrowing pointless.
 */
export function blockingSignature(
  match,
  prefixLength = MATCH_CONFIG.blockingPrefixLength
) {
  const signature = new Set();

  for (const raw of [match.home, match.away]) {
    for (const token of tokenize(
      normalizeTeamName(raw, { sport: match.sport })
    )) {
      if (WEAK_TOKENS.has(token)) continue;
      signature.add(
        token.length >= prefixLength ? token.slice(0, prefixLength) : token
      );
    }
  }

  return signature;
}

/**
 * Builds a hierarchical index over a match list.
 *
 * Shape:  Map<sport, Map<dateKey, Map<prefix, number[]>>>
 *
 * So when looking for candidates for "FUTBOL / 2026-09-24", basketball
 * matches, the other dates and matches with no shared token are NEVER
 * scanned.
 */
export function buildMatchIndex(matches, options = {}) {
  const prefixLength =
    options.prefixLength ?? MATCH_CONFIG.blockingPrefixLength;

  const bySport = new Map();
  const signatures = new Array(matches.length);

  matches.forEach((match, index) => {
    const signature = blockingSignature(match, prefixLength);
    signatures[index] = signature;

    let byDate = bySport.get(match.sport);
    if (!byDate) {
      byDate = new Map();
      bySport.set(match.sport, byDate);
    }

    let byPrefix = byDate.get(match.date);
    if (!byPrefix) {
      byPrefix = new Map();
      byDate.set(match.date, byPrefix);
    }

    for (const prefix of signature) {
      let bucket = byPrefix.get(prefix);
      if (!bucket) {
        bucket = [];
        byPrefix.set(prefix, bucket);
      }
      bucket.push(index);
    }

    // A match whose signature comes out empty (all names are weak words,
    // say) would appear in no bucket; it goes into a separate "unsigned"
    // list added to every query so it is not silently lost.
    if (signature.size === 0) {
      let bucket = byPrefix.get("");
      if (!bucket) {
        bucket = [];
        byPrefix.set("", bucket);
      }
      bucket.push(index);
    }
  });

  return { bySport, signatures, prefixLength };
}

/**
 * Returns the candidate indexes for a match.
 *
 * Narrows in the order SPORT -> DATE BUCKET -> SHARED TOKEN PREFIX; the
 * order is deliberate: the cheapest and most certain elimination comes
 * first.
 *
 * @returns {number[]} candidate indexes in the target list (deduplicated)
 */
export function findMatchCandidates(match, index, options = {}) {
  const dateToleranceDays =
    options.dateToleranceDays ?? MATCH_CONFIG.dateToleranceDays;

  // 1) SPORT -- candidates are never sought in a different sport.
  const byDate = index.bySport.get(match.sport);
  if (!byDate) return [];

  const signature = blockingSignature(match, index.prefixLength);
  const found = new Set();

  // 2) DATE -- the same day and (for midnight shifts) its neighbours.
  for (let offset = -dateToleranceDays; offset <= dateToleranceDays; offset++) {
    const dateKey =
      offset === 0 ? match.date : dateKeyOffset(match.date, offset);
    if (!dateKey) continue;

    const byPrefix = byDate.get(dateKey);
    if (!byPrefix) continue;

    // 3) TEAM -- only matches carrying a shared prefix.
    for (const prefix of signature) {
      const bucket = byPrefix.get(prefix);
      if (!bucket) continue;
      for (const candidate of bucket) found.add(candidate);
    }

    const unsigned = byPrefix.get("");
    if (unsigned) for (const candidate of unsigned) found.add(candidate);
  }

  return [...found];
}
