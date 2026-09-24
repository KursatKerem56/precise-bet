/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs/promises";

import { compareMatchTimesMain } from "./compare-match-times";

import { getSites } from "@Panel";

import { fetchSiteMatches, isSupportedSite } from "@Match/Fetchers";

// The single source for the sport key -> normalised id conversion.
import { getSportByKey } from "@Match/Fetchers/Sports/catalog.js";

import { Match } from "@Match/Models";

import { EMatchSport } from "@Match/Constants";
import { EPanelSite } from "@Panel/Constants";

import logger from "@Utils/Logger";

/** The wait between two runs. */
const FETCH_INTERVAL_MS = Number(
  process.env.MATCH_FETCH_INTERVAL_MS || 1000 * 60 * 2
);

const saveMatches = async (site: EPanelSite) => {
  const jsonFilePath = `./${site.toLowerCase()}-matches.json`;

  const fileContent = await fs.readFile(jsonFilePath, "utf-8");

  const matchesRaw = JSON.parse(fileContent);

  const foundSite = (await getSites()).find((_site) => _site.site === site);

  if (!foundSite) return;

  const matchesWillBeSaved = [];

  for (const sportKey of Object.keys(matchesRaw)) {
    // PREVIOUSLY: a nested ternary silently mapped EVERY unknown key to
    // TENNIS. As new sports were added, that quietly corrupted the data.
    // It now resolves through the catalog and an unresolved key is SKIPPED.
    const sport = getSportByKey(sportKey);

    if (!sport) {
      logger.warn(`[${site}] skipped sport key missing from the catalog: ${sportKey}`);
      continue;
    }

    const leagues = matchesRaw[sportKey] ?? {};

    const data = {
      site: foundSite._id.toString(),
      sport: sport.id as EMatchSport,
      leagues: Object.keys(leagues).map((leagueKey) => ({
        league: leagueKey,
        dates: Object.keys(leagues[leagueKey] ?? {}).map((dateKey) => ({
          date: dateKey,
          matches: (leagues[leagueKey][dateKey] ?? []).map((match: any) => ({
            home: match.home,
            away: match.away,
            time: match.time,
          })),
        })),
      })),
    };

    matchesWillBeSaved.push(data);
  }

  if (!matchesWillBeSaved.length) {
    // We do NOT delete the existing records for an empty result; a
    // temporary fetch failure must not turn into permanent data loss.
    logger.warn(`[${site}] no matches to save; the existing records are kept.`);
    return;
  }

  await Match.deleteMany({ site: foundSite._id.toString() });

  // insertMany goes in a single round trip; there used to be a separate
  // create() call per match group.
  await Match.insertMany(matchesWillBeSaved);
};

/** Prevents a second round from starting at the same time. */
let fetchInProgress = false;

let fetchTimer: NodeJS.Timeout | null = null;

const runMatchFetchers = async () => {
  const sites = await getSites();

  // The sites are independent of each other: if one blows up the others
  // carry on.
  const results = await Promise.allSettled(
    sites.map(async (site) => {
      if (!isSupportedSite(site.site)) {
        logger.warn(`No fetcher defined for: ${site.site}`);
        return;
      }

      logger.info(`Match fetch starting: ${site.site}`);

      await fetchSiteMatches(site.site, site.link);

      await saveMatches(site.site);

      logger.info(`Match fetch finished: ${site.site}`);
    })
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.error(
        `Match fetch failed: ${sites[index]?.site}`,
        result.reason
      );
    }
  });

  // The comparison should run even when some of the fetches failed: it is
  // a step that produces a meaningful result from whatever files exist.
  try {
    await compareMatchTimesMain();
  } catch (error) {
    logger.error("Match time comparison failed", error);
  }
};

/**
 * Starts the periodic match fetch.
 *
 * PREVIOUSLY: `setTimeout(initMatchFetchers, 2 min)` was scheduled
 * INDEPENDENTLY of how long a fetch took, so rounds overlapped whenever a
 * fetch ran longer than 2 minutes. On top of that, if compareMatchTimesMain()
 * threw, the rescheduling line was never reached and the loop died silently.
 *
 * Now: one round at a time, and the next round is scheduled IN EVERY CASE
 * (errors included) AFTER the previous one has finished.
 */
const initMatchFetchers = async () => {
  if (fetchInProgress) {
    logger.warn("The previous match fetch is still running; this round was skipped.");
    return;
  }

  fetchInProgress = true;

  try {
    await runMatchFetchers();
  } catch (error) {
    logger.error("Match fetch round failed", error);
  } finally {
    fetchInProgress = false;

    if (fetchTimer) clearTimeout(fetchTimer);

    fetchTimer = setTimeout(initMatchFetchers, FETCH_INTERVAL_MS);

    // The timer must not keep the process from exiting.
    fetchTimer.unref?.();
  }
};

/** Stops the periodic fetch (for tests and a clean shutdown). */
const stopMatchFetchers = () => {
  if (fetchTimer) clearTimeout(fetchTimer);

  fetchTimer = null;
};

const getMatches = async () => {
  const sites = await getSites();

  const matchesBySite: Record<string, any[]> = {};

  // The sites are independent; query them in parallel instead of waiting
  // on each in turn.
  const perSite = await Promise.all(
    sites.map(async (site) => ({
      site: site.site,
      matches: await Match.find({ site: site._id.toString() }),
    }))
  );

  for (const entry of perSite) matchesBySite[entry.site] = entry.matches;

  return matchesBySite;
};

const getComparedMatches = async () => {
  const jsonFilePath = `./match-times-diff.json`;

  const fileContent = await fs.readFile(jsonFilePath, "utf-8");

  return JSON.parse(fileContent);
};

export {
  initMatchFetchers,
  stopMatchFetchers,
  runMatchFetchers,
  getMatches,
  getComparedMatches,
};
