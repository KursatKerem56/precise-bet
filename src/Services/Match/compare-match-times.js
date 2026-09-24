#!/usr/bin/env node
/**
 * MATCH TIME COMPARATOR  (ES6 / ESM, zero dependencies, Node 18+)
 *
 * Compares the match lists of three sites and reports, as JSON, the cases
 * where the SAME match is shown at a DIFFERENT time on different sites.
 *
 * The input is the SHARED structure all three fetchers produce:
 *
 *   { "FUTBOL": { "Ülke - Lig": { "2026-09-18": [ {eventId,leagueId,home,away,time} ] } }, ... }
 *
 * ---------------------------------------------------------------------------
 * THE MATCHING HIERARCHY
 *
 *   SPORT -> LEAGUE -> DATE -> TEAM -> TIME
 *
 * This order is critical for both accuracy and performance: the cheap,
 * certain eliminations run first and the expensive fuzzy comparison is left
 * for last.
 *
 *   1) SPORT  : The fetchers already produce a catalog key (FUTBOL,
 *               BASKETBOL...). A different sport = NEVER a match; this is
 *               the top level of the candidate index, so basketball games
 *               are never scanned for a football game.
 *
 *   2) LEAGUE : When it resolves to a canonical league id it is a RELIABLE
 *               constraint (a different id -> immediate elimination). When
 *               it does not resolve it is a soft signal, because the three
 *               sites write league names very differently
 *               ("International Clubs - UEFA Champions League" vs
 *               "Europe - UEFA Champions League - League Stage"). The
 *               qualifiers (Women / U21 / Reserve), however, are a HARD
 *               constraint in every case.
 *
 *   3) DATE   : The same day + (for games crossing midnight) the
 *               neighbouring days. A neighbouring-day candidate is only
 *               accepted when the time gap is no more than a reasonable
 *               midnight shift; otherwise "the same teams' OTHER game the
 *               next day" would match by mistake.
 *
 *   4) TEAM   : The genuinely decisive step. Exact -> alias -> guarded
 *               fuzzy, in that order. A qualifier mismatch (B team, U19,
 *               women) cuts the match off however similar the names are.
 *
 *   5) TIME   : Through a single epoch number; "23:50 vs 00:10" is really
 *               20 minutes, not 23 hours 40 minutes.
 *
 * The matching logic itself lives in the modules under ./Matching/; this
 * file reads the input, drives the matching and produces the report.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *
 *   node compare-match-times.js betist-matches.json matches.json -o diff.json
 *   node compare-match-times.js *.json --summary
 *   node compare-match-times.js a.json b.json --tolerans 5      (ignore gaps up to 5 min)
 *   node compare-match-times.js a.json b.json --eslesmeyenler   (also add the unmatched ones)
 *   node compare-match-times.js a.json b.json --duz             (a flat list, no grouping)
 */

import { readFile, writeFile } from "node:fs/promises";

// The sport name mapping is not duplicated here; it comes from the SAME
// catalog as the fetchers. The SPORT_CANON/SPORT_ORDER lists in this file
// used to be independent of the fetchers, so when a new sport was added and
// this file was not updated, that sport counted as "BILINMEYEN" and was
// never compared.
import {
  resolveSport,
  SPORT_ORDER as CATALOG_SPORT_ORDER,
} from "./Fetchers/Sports/catalog.js";

import {
  MATCH_CONFIG,
  buildLeagueIndex,
  buildMatchIndex,
  findMatchCandidates,
  compareMatches,
  resolveLeague,
  normalizeTimestamp,
  UnresolvedCollector,
} from "./Matching/index.js";

// Backwards compatibility: this file's old public API is re-exported.
// Because src/Services/Match/index.ts does `export * from
// "./compare-match-times"`, these names must not disappear.
export {
  foldText,
  normalizeTeamName,
  normalizeLeagueName,
  similarityRatio,
  teamSimilarity,
  leagueSimilarity,
  toEpochMs,
  compareMatches,
  compareMatchTimes,
  calculateMatchConfidence,
  normalizeTimestamp,
  calculateTimeDifference,
  resolveTeam,
  resolveLeague,
  compareTeams,
  compareLeagues,
  buildMatchIndex,
  findMatchCandidates,
  MATCH_CONFIG,
  MATCH_RESULT,
  CITY_ABBREVIATIONS,
} from "./Matching/index.js";

export { DEFAULT_TIMEZONE_OFFSET_MINUTES } from "./Matching/datetime.js";

import { DEFAULT_TIMEZONE_OFFSET_MINUTES } from "./Matching/datetime.js";

/**
 * The old `KNOWN_ALIASES` constant. The single source of truth is now
 * ./Matching/team_aliases.json; this object only exists so the old public
 * API keeps working, and it is derived from that JSON.
 */
export { KNOWN_ALIASES } from "./Matching/legacy-aliases.js";

/* =========================================================================
 * 1) CANONICALISING THE SPORT NAME
 * ====================================================================== */

/** Every sport key recognised in the catalog (used by isFetcherShape). */
const SPORT_KEYS = new Set(CATALOG_SPORT_ORDER);

export function canonicalSport(name) {
  const sport = resolveSport(name);

  if (sport) return sport.key;

  return name ? String(name).toUpperCase() : "BILINMEYEN";
}

// The league alias index is built by resolving the sport keys through the
// catalog. ONCE when the module loads, not on every comparison.
buildLeagueIndex((sportName) => resolveSport(sportName)?.key ?? null);

/* =========================================================================
 * 2) REDUCING THE INPUT TO THE SHARED MODEL
 * ====================================================================== */

/**
 * The shared match model:
 *   { site, sport, league, leagueRaw, country, leagueInfo,
 *     date, time, epoch, home, away, eventId }
 *
 * `leagueInfo` and `epoch` are computed here ONCE. The league name and the
 * date used to be re-parsed on every comparison; that is work repeated a
 * few hundred times per candidate.
 */

/** Does the file follow the fetcher output structure? */
export function isFetcherShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return Object.keys(data).some((k) => SPORT_KEYS.has(canonicalSport(k)));
}

/** Turns fetcher output into a flat match list. */
export function parseFetcherOutput(
  data,
  site,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
  collector = null,
  sourceName = site
) {
  const out = [];

  for (const [sportRaw, leagues] of Object.entries(data)) {
    if (!leagues || typeof leagues !== "object") continue;

    const sport = canonicalSport(sportRaw);

    for (const [leagueKey, dates] of Object.entries(leagues)) {
      if (!dates || typeof dates !== "object") continue;

      // The league key has the form "Country - League Name". Resolution runs
      // once PER LEAGUE, not per match: real data holds ~6300 matches across
      // ~500 league keys.
      const leagueInfo = resolveLeague(sport, leagueKey);

      if (collector && !leagueInfo.canonicalId) {
        collector.addLeague({
          source: sourceName,
          sport,
          country: leagueInfo.country,
          league: leagueInfo.name,
        });
      }

      for (const [date, matches] of Object.entries(dates)) {
        if (!Array.isArray(matches)) continue;

        for (const m of matches) {
          const stamp = normalizeTimestamp(date, m.time, offsetMinutes);

          out.push({
            site,
            sport,
            league: leagueInfo.name,
            leagueRaw: leagueKey,
            country: leagueInfo.countryRaw,
            leagueInfo,
            date,
            time: stamp.time,
            epoch: stamp.epoch,
            home: m.home ?? null,
            away: m.away ?? null,
            eventId: m.eventId != null ? String(m.eventId) : null,
          });
        }
      }
    }
  }

  return out;
}

/** Validates the file and converts it into the shared model. */
export function normalizeInput(
  data,
  site,
  {
    offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
    collector = null,
    sourceName = site,
  } = {}
) {
  if (!isFetcherShape(data)) {
    throw new Error(
      `The "${site}" file was not recognised. Expected structure: { "FUTBOL": { "Ülke - Lig": { "2026-09-18": [ ... ] } }, ... }`
    );
  }
  return {
    matches: parseFetcherOutput(
      data,
      site,
      offsetMinutes,
      collector,
      sourceName
    ),
  };
}

/* =========================================================================
 * 3) MATCHING
 * ====================================================================== */

/**
 * The defaults. The SINGLE source of truth for the numbers is
 * ./Matching/config.js; this is only a view preserving the old `DEFAULTS`
 * API.
 */
export const DEFAULTS = {
  teamThreshold: MATCH_CONFIG.teamThreshold,
  leagueThreshold: MATCH_CONFIG.leagueThreshold,
  requireLeague: MATCH_CONFIG.requireLeague,
  dateToleranceDays: MATCH_CONFIG.dateToleranceDays,
  toleranceMinutes: MATCH_CONFIG.toleranceMinutes,
  lowLeagueScore: MATCH_CONFIG.lowLeagueScore,
  teamScoreWhenLeagueLow: MATCH_CONFIG.teamScoreWhenLeagueLow,
  maxAdjacentDayDiffMinutes: MATCH_CONFIG.maxAdjacentDayDiffMinutes,
  crossDatePenalty: MATCH_CONFIG.crossDatePenalty,
  minConfidence: MATCH_CONFIG.possibleConfidence,
};

/**
 * Matches two lists against each other.
 *
 * THE OLD VERSION: every match was scored one by one against ALL matches in
 * its "sport|date" bucket -> 979,978 candidate pairs across three sites,
 * 3.9 million fuzzy team comparisons, ~72 seconds.
 *
 * THE NEW VERSION: the candidate pool comes from an inverted index over
 * team names (see Matching/candidates.js) -> 43,501 candidate pairs (4.4%)
 * while keeping 99.95% of the correct matches.
 *
 * @returns {{pairs: Array, onlyA: Array, onlyB: Array}}
 */
export function matchLists(listA, listB, options = {}) {
  const opt = { ...DEFAULTS, ...options };

  // The hierarchical index of the target list: sport -> date -> tokenPrefix.
  const index = buildMatchIndex(listB);

  const candidates = [];

  listA.forEach((a, ai) => {
    for (const bi of findMatchCandidates(a, index, opt)) {
      const b = listB[bi];

      const result = compareMatches(a, b, opt);
      if (!result.ok) continue;
      if (result.confidence < opt.minConfidence) continue;

      const crossDate = a.date !== b.date;

      candidates.push({
        ai,
        bi,
        teamScore: result.teamScore,
        leagueScore: result.leagueScore,
        flipped: result.flipped,
        confidence: result.confidence,
        decision: result.decision,
        diffMinutes: result.time?.diffMinutes ?? null,
        crossDate,
        // The ranking score: team weighted, league secondary, time gap
        // tertiary. A same-day candidate ALWAYS ranks ahead of a
        // neighbouring-day one; when the same teams have a record both today
        // and tomorrow, the same day is the right one.
        rank:
          result.teamScore * 1000 +
          result.leagueScore -
          (crossDate ? opt.crossDatePenalty : 0) -
          Math.min(Math.abs(result.time?.diffMinutes ?? 0), 999) / 1000,
      });
    }
  });

  // Match greedily from the best candidate down (each match is used once).
  candidates.sort((x, y) => y.rank - x.rank);

  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];

  for (const c of candidates) {
    if (usedA.has(c.ai) || usedB.has(c.bi)) continue;
    usedA.add(c.ai);
    usedB.add(c.bi);

    pairs.push({
      a: listA[c.ai],
      b: listB[c.bi],
      indexA: c.ai,
      indexB: c.bi,
      teamScore: Math.round(c.teamScore * 10) / 10,
      leagueScore: Math.round(c.leagueScore * 10) / 10,
      confidence: Math.round(c.confidence * 1000) / 1000,
      decision: c.decision,
      flipped: c.flipped,
      diffMinutes: c.diffMinutes,
      crossDate: c.crossDate,
      isDifferent:
        c.diffMinutes == null
          ? false
          : Math.abs(c.diffMinutes) > opt.toleranceMinutes,
    });
  }

  return {
    pairs,
    onlyA: listA.filter((_, i) => !usedA.has(i)),
    onlyB: listB.filter((_, i) => !usedB.has(i)),
  };
}

/* =========================================================================
 * 6) MULTI-SITE CLUSTERING
 *
 * When comparing more than two sites, the facts "A matched B" and "B
 * matched C" have to be merged into clusters representing the SAME MATCH.
 * A union-find structure is used here; the one constraint is that a cluster
 * may contain AT MOST ONE match from the same site (otherwise two different
 * games would be fused into one).
 * ====================================================================== */

class DisjointSet {
  constructor() {
    this.parent = new Map();
  }

  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return true;
    this.parent.set(ra, rb);
    return true;
  }
}

/**
 * Takes the per-site lists and produces the clusters representing the same
 * match.
 *
 * @param {Record<string, Array>} bySite  site name -> match list
 * @returns {{clusters: Array, pairStats: Array}}
 */
export function clusterMatches(bySite, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const siteNames = Object.keys(bySite);

  // The global key: "site#index"
  const keyOf = (site, index) => `${site}#${index}`;
  const entryOf = (key) => {
    const at = key.lastIndexOf("#");
    const site = key.slice(0, at);
    return { site, match: bySite[site][Number(key.slice(at + 1))] };
  };

  const ds = new DisjointSet();
  // Track which sites each cluster contains (to prevent a clash)
  const clusterSites = new Map(); // root -> Set(site)

  for (const site of siteNames) {
    bySite[site].forEach((_, i) => {
      const key = keyOf(site, i);
      ds.find(key);
      clusterSites.set(key, new Set([site]));
    });
  }

  const pairStats = [];

  // Pairwise matching for every pair of sites
  for (let i = 0; i < siteNames.length; i++) {
    for (let j = i + 1; j < siteNames.length; j++) {
      const siteA = siteNames[i];
      const siteB = siteNames[j];

      const { pairs } = matchLists(bySite[siteA], bySite[siteB], opt);

      for (const pair of pairs) {
        // matchLists now returns the indexes too. This used to call
        // `bySite[siteA].indexOf(pair.a)`: a linear scan through a 1500-2800
        // element array for every match, i.e. wasted work proportional to
        // match count x list length.
        const ia = pair.indexA;
        const ib = pair.indexB;
        if (ia == null || ib == null) continue;

        const ra = ds.find(keyOf(siteA, ia));
        const rb = ds.find(keyOf(siteB, ib));
        if (ra === rb) continue; // already in the same cluster (joined via another site)

        const setA = clusterSites.get(ra) ?? new Set();
        const setB = clusterSites.get(rb) ?? new Set();

        // Two matches from the same site cannot enter one cluster.
        let clash = false;
        for (const s of setB) if (setA.has(s)) clash = true;
        if (clash) continue;

        ds.union(ra, rb);
        const root = ds.find(ra);
        clusterSites.set(root, new Set([...setA, ...setB]));
      }

      // NOTE: the REAL match count is reported here. A "how many created a
      // new union" count would be misleading: after A-B and A-C matched,
      // B-C would show as 0 because they are already in the same cluster.
      pairStats.push({ siteA, siteB, eslesen: pairs.length });
    }
  }

  // Collect the roots and build the clusters
  const groups = new Map();

  for (const site of siteNames) {
    bySite[site].forEach((_, i) => {
      const key = keyOf(site, i);
      const root = ds.find(key);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(key);
    });
  }

  const clusters = [];

  for (const keys of groups.values()) {
    const entries = keys.map(entryOf);

    // Base the cluster's identity on the first site's data (in TARGET order)
    entries.sort(
      (x, y) => siteNames.indexOf(x.site) - siteNames.indexOf(y.site)
    );

    const bySiteMatch = {};
    for (const e of entries) bySiteMatch[e.site] = e.match;

    clusters.push({ entries, bySite: bySiteMatch });
  }

  return { clusters, pairStats };
}

/* =========================================================================
 * 7) PRODUCING THE OUTPUT
 * ====================================================================== */

const collator = new Intl.Collator("tr", {
  sensitivity: "base",
  numeric: true,
});
const SPORT_ORDER = CATALOG_SPORT_ORDER;
const sportRank = (s) => {
  const i = SPORT_ORDER.indexOf(s);
  return i === -1 ? SPORT_ORDER.length : i;
};

/** Runs the time comparison for one cluster. */
function analyseCluster(cluster, siteNames, toleranceMinutes) {
  const present = siteNames.filter((s) => cluster.bySite[s]);
  const missing = siteNames.filter((s) => !cluster.bySite[s]);

  const epochs = present
    .map((s) => ({ site: s, epoch: cluster.bySite[s].epoch }))
    .filter((x) => x.epoch != null);

  if (epochs.length < 2) {
    return {
      present,
      missing,
      maxDiffMinutes: 0,
      isDifferent: false,
      deviating: [],
    };
  }

  const values = epochs.map((x) => x.epoch);
  const maxDiffMinutes = Math.round(
    (Math.max(...values) - Math.min(...values)) / 60000
  );

  // The reference: the most frequent time (the earliest one on a tie).
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  let reference = values[0];
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < reference)) {
      reference = value;
      bestCount = count;
    }
  }

  const deviating = epochs
    .filter((x) => Math.abs(x.epoch - reference) > toleranceMinutes * 60000)
    .map((x) => ({
      site: x.site,
      farkDakika: Math.round((x.epoch - reference) / 60000),
    }));

  return {
    present,
    missing,
    maxDiffMinutes,
    isDifferent: maxDiffMinutes > toleranceMinutes,
    deviating,
  };
}

function clusterToRow(cluster, siteNames, analysis) {
  // Use the first site present for the display name
  const first = cluster.bySite[analysis.present[0]];

  const saatler = {};
  const tarihler = {};
  const ligler = {};
  const takimlar = {};

  for (const site of siteNames) {
    const m = cluster.bySite[site];
    if (!m) continue;
    saatler[site] = m.time;
    tarihler[site] = m.date;
    ligler[site] = m.leagueRaw;
    takimlar[site] = `${m.home} - ${m.away}`;
  }

  // When the sites also disagree about the match's DAY, flag that
  // separately. "1380 minutes apart" on its own would be misleading: what
  // actually happened is that the DATE, not the time, was written
  // differently.
  const gunler = new Set(Object.values(tarihler));
  const tarihFarkli = gunler.size > 1;

  return {
    sport: first.sport,
    league: first.league,
    date: first.date,
    home: first.home,
    away: first.away,
    saatler,
    tarihler,
    tarihFarkli,
    maxFarkDakika: analysis.maxDiffMinutes,
    sapanSiteler: analysis.deviating,
    eksikSiteler: analysis.missing,
    ligler,
    takimlar,
  };
}

/** Turns the flat row list into a SPORT -> LEAGUE -> DATE tree. */
function groupRows(rows) {
  const tree = {};
  for (const r of rows) {
    tree[r.sport] ??= {};
    tree[r.sport][r.league] ??= {};
    tree[r.sport][r.league][r.date] ??= [];
    tree[r.sport][r.league][r.date].push(r);
  }

  const sorted = {};
  for (const sport of Object.keys(tree).sort(
    (x, y) => sportRank(x) - sportRank(y) || collator.compare(x, y)
  )) {
    sorted[sport] = {};
    for (const league of Object.keys(tree[sport]).sort(collator.compare)) {
      sorted[sport][league] = {};
      for (const date of Object.keys(tree[sport][league]).sort()) {
        sorted[sport][league][date] = tree[sport][league][date].sort(
          (p, q) =>
            String(Object.values(p.saatler)[0] ?? "").localeCompare(
              String(Object.values(q.saatler)[0] ?? "")
            ) || collator.compare(`${p.home} ${p.away}`, `${q.home} ${q.away}`)
        );
      }
    }
  }
  return sorted;
}

/** "dir/betist-matches.json" -> "betist" */
function siteNameFromPath(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? "site";
  return base.replace(/\.json$/i, "").replace(/[-_]?matches?$/i, "") || base;
}

/** When files share a name, disambiguate them with a trailing number. */
function uniqueSiteNames(filePaths) {
  const names = filePaths.map(siteNameFromPath);
  const seen = new Map();
  return names.map((n) => {
    const count = (seen.get(n) ?? 0) + 1;
    seen.set(n, count);
    return count === 1 ? n : `${n}_${count}`;
  });
}

/**
 * End to end: read 2 or more files, compare them and return the result.
 *
 * @param {string[]} filePaths
 * @param {object} options
 */
export async function compareFiles(filePaths, options = {}) {
  const opt = { ...DEFAULTS, includeUnmatched: false, flat: false, ...options };

  if (filePaths.length < 2) {
    throw new Error("At least two files are required.");
  }

  const allSiteNames = uniqueSiteNames(filePaths);

  const bySite = {};
  const kaynaklar = {};
  const okunamayan = [];

  // Collect the league/team names missing from the alias database.
  // OFF by default (enabled with MATCH_DEBUG_UNRESOLVED=1) so it does not
  // produce thousands of log lines on every production run.
  const collector = new UnresolvedCollector({
    enabled: opt.collectUnresolved ?? MATCH_CONFIG.collectUnresolved,
  });

  // If a fetcher did not run, its file may be missing or corrupt. That used
  // to blow up the whole comparison, leaving even the two healthy files
  // unused. A broken file is now skipped and the reason reported.
  for (let i = 0; i < filePaths.length; i++) {
    const site = allSiteNames[i];

    try {
      const raw = JSON.parse(await readFile(filePaths[i], "utf8"));
      // `site` (the short name) is used in the reports; the file path is
      // only meaningful in the error message, so that is what goes into
      // normalizeInput.
      const parsed = normalizeInput(raw, filePaths[i], {
        ...opt,
        collector,
        sourceName: site,
      });

      bySite[site] = parsed.matches.map((m) => ({ ...m, site }));

      if (collector.enabled) {
        for (const m of bySite[site]) {
          for (const team of [m.home, m.away]) {
            collector.addTeam({
              source: site,
              sport: m.sport,
              league: m.leagueRaw,
              team,
            });
          }
        }
      }
      kaynaklar[site] = { dosya: filePaths[i], macSayisi: bySite[site].length };
    } catch (error) {
      okunamayan.push({ site, dosya: filePaths[i], hata: error.message });
      console.warn(`[COMPARE] could not read ${filePaths[i]}: ${error.message}`);
    }
  }

  const siteNames = allSiteNames.filter((site) => bySite[site]);

  if (siteNames.length < 2) {
    throw new Error(
      `At least two readable files are required for a comparison (read: ${siteNames.length}).`
    );
  }

  const { clusters, pairStats } = clusterMatches(bySite, opt);

  const analysed = clusters.map((c) => ({
    cluster: c,
    analysis: analyseCluster(c, siteNames, opt.toleranceMinutes),
  }));

  // Only matches present on MORE THAN ONE site can be compared.
  const comparable = analysed.filter((x) => x.analysis.present.length > 1);
  const different = comparable.filter((x) => x.analysis.isDifferent);

  const rows = different.map((x) =>
    clusterToRow(x.cluster, siteNames, x.analysis)
  );

  // Per-site statistics
  const siteBazinda = {};
  for (const site of siteNames) {
    const only = analysed.filter(
      (x) => x.analysis.present.length === 1 && x.analysis.present[0] === site
    ).length;
    siteBazinda[site] = {
      toplam: bySite[site].length,
      sadeceBuSitede: only,
    };
  }

  // The distribution by how many sites a match appears on
  const kapsam = {};
  for (const x of analysed) {
    const n = x.analysis.present.length;
    const key = `${n}_sitede`;
    kapsam[key] = (kapsam[key] ?? 0) + 1;
  }

  const result = {
    olusturulma: new Date().toISOString(),
    siteler: siteNames,
    kaynaklar,
    okunamayan,
    ayarlar: {
      toleransDakika: opt.toleranceMinutes,
      takimEsigi: opt.teamThreshold,
      ligEsigi: opt.leagueThreshold,
      ligZorunlu: opt.requireLeague,
      tarihToleransGun: opt.dateToleranceDays,
    },
    ozet: {
      toplamMacGrubu: analysed.length,
      karsilastirilabilir: comparable.length,
      saatiFarkli: different.length,
      saatiAyni: comparable.length - different.length,
      kapsam,
      siteBazinda,
      ikiliEslesme: pairStats,
    },
    farkliMaclar: opt.flat ? rows : groupRows(rows),
  };

  // A SUGGESTION IS NOT AN AUTOMATIC ALIAS: what the fuzzy matcher finds is
  // never written to the alias files, only presented for human approval. A
  // wrong alias silently breaks the entire matching system.
  const cozulemeyen = collector.report();
  if (cozulemeyen) result.cozulemeyen = cozulemeyen;

  if (opt.includeUnmatched) {
    const slim = (m) => ({
      sport: m.sport,
      league: m.leagueRaw,
      date: m.date,
      time: m.time,
      home: m.home,
      away: m.away,
      eventId: m.eventId,
    });

    const eslesmeyenler = {};
    for (const site of siteNames) {
      eslesmeyenler[site] = analysed
        .filter(
          (x) =>
            x.analysis.present.length === 1 && x.analysis.present[0] === site
        )
        .map((x) => slim(x.cluster.bySite[site]));
    }
    result.eslesmeyenler = eslesmeyenler;
  }

  return result;
}

/* =========================================================================
 * 8) THE COMMAND LINE
 * ====================================================================== */

function parseArgs(argv) {
  const files = [];
  const options = { out: null, summary: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--out") options.out = argv[++i];
    else if (arg === "--tolerans" || arg === "--tolerance")
      options.toleranceMinutes = Number(argv[++i]);
    else if (arg === "--takim-esigi") options.teamThreshold = Number(argv[++i]);
    else if (arg === "--lig-esigi") options.leagueThreshold = Number(argv[++i]);
    else if (arg === "--lig-zorunlu") options.requireLeague = true;
    else if (arg === "--tarih-tolerans")
      options.dateToleranceDays = Number(argv[++i]);
    else if (arg === "--eslesmeyenler") options.includeUnmatched = true;
    else if (arg === "--duz" || arg === "--flat") options.flat = true;
    else if (arg === "--ozet" || arg === "--summary") options.summary = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else files.push(arg);
  }
  return { files, options };
}

function printHelp() {
  console.log(`
Match time comparator (sport -> league -> date -> team matching)
Compares the output of 2, 3 or more sites at once.

Usage:
  node compare-match-times.js betist-matches.json mavibet-matches.json virusbet-matches.json -o diff.json

Options:
  -o, --out <file>        Write the result to a file (default: print to screen)
      --ozet              Show a short summary table instead of JSON
      --tolerans <min>    Treat a gap of at most this many minutes as "the same" (default: 0)
      --takim-esigi <n>   Team name similarity threshold 0-100 (default: ${DEFAULTS.teamThreshold})
      --lig-esigi <n>     League name similarity threshold 0-100 (default: ${DEFAULTS.leagueThreshold})
      --lig-zorunlu       Require a league match (default: weight only)
      --tarih-tolerans <d> Day tolerance (default: ${DEFAULTS.dateToleranceDays}, for midnight shifts)
      --eslesmeyenler     Also add matches found on a single site to the output
      --duz               Produce a flat list instead of a grouped one
  -h, --help              This help

The input files are betist / mavibet / virusbet fetcher outputs (all in the
same shape). Their order does not matter; site names are derived from the
file names.
`);
}

function printSummary(result) {
  const siteler = result.siteler;
  const pad = Math.max(...siteler.map((s) => s.length), 10);

  console.log("");
  for (const [name, src] of Object.entries(result.kaynaklar)) {
    console.log(
      `  ${name.padEnd(pad)}  ${String(src.macSayisi).padStart(5)} matches   (${src.dosya})`
    );
  }

  console.log("");
  console.log(`  Total match groups   : ${result.ozet.toplamMacGrubu}`);
  console.log(
    `  Comparable           : ${result.ozet.karsilastirilabilir}  (on 2+ sites)`
  );
  console.log(`  DIFFERENT TIME       : ${result.ozet.saatiFarkli}`);
  console.log(`  Same time            : ${result.ozet.saatiAyni}`);

  console.log("");
  console.log("  Found on how many sites:");
  for (const [key, count] of Object.entries(result.ozet.kapsam).sort()) {
    console.log(`    ${key.replace("_", " ")}: ${count}`);
  }

  console.log("");
  console.log("  Pairwise matches:");
  for (const p of result.ozet.ikiliEslesme) {
    console.log(`    ${p.siteA} <-> ${p.siteB}: ${p.eslesen}`);
  }

  console.log("");
  const tree = result.farkliMaclar;

  if (Array.isArray(tree)) {
    for (const r of tree) {
      console.log(
        `  ${r.sport} | ${r.league} | ${r.date} | ${r.home} - ${r.away}`
      );
      console.log(`      ${formatTimes(r, siteler)}`);
    }
    return;
  }

  for (const [sport, leagues] of Object.entries(tree)) {
    console.log(`${sport}`);
    for (const [league, dates] of Object.entries(leagues)) {
      console.log(`  ${league}`);
      for (const [date, rows] of Object.entries(dates)) {
        for (const r of rows) {
          console.log(
            `    ${date}  ${r.home} - ${r.away}   (max gap ${r.maxFarkDakika} min)`
          );
          console.log(`        ${formatTimes(r, siteler)}`);
        }
      }
    }
    console.log("");
  }
}

function formatTimes(row, siteler) {
  return siteler
    .map((s) => {
      const time = row.saatler[s];
      if (!time) return `${s}: -`;
      const dev = row.sapanSiteler.find((d) => d.site === s);
      const mark = dev
        ? ` (${dev.farkDakika > 0 ? "+" : ""}${dev.farkDakika})`
        : "";
      return `${s}: ${time}${mark}`;
    })
    .join("   ");
}

async function compareMatchTimesMain() {
  const args = [
    "./virus_bet-matches.json",
    "./mavi_bet-matches.json",
    "./betist-matches.json",
    "-o",
    "match-times-diff.json",
  ];

  console.log(args);

  const { files, options } = parseArgs(args);

  if (options.help || files.length < 2) {
    printHelp();
    // process.exit(options.help ? 0 : 1);
  }

  const result = await compareFiles(files, options);

  if (options.summary) {
    printSummary(result);
    return;
  }

  const json = JSON.stringify(result, null, 2);
  if (options.out) {
    await writeFile(options.out, json, "utf8");
    console.log(
      `Written: ${options.out}  (${result.ozet.saatiFarkli} matches with a different time)`
    );
  } else {
    console.log(json);
  }
}

export { compareMatchTimesMain };

// Running it directly gives the CLI; importing it gives only the functions.
// if (
//   process.argv[1] &&
//   import.meta.url === new URL(`file://${process.argv[1]}`).href
// ) {
//   compareMatchTimesMain().catch((error) => {
//     console.error("Error:", error.message);
//     process.exitCode = 1;
//   });
// }
