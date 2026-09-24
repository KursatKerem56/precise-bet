/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The public face of the fetchers.
 *
 * The existing `*MatchFetcherMain(siteUrl)` signatures are kept EXACTLY as
 * they were -- the calling code (Match.service.ts) does not have to change.
 *
 * On top of that there is a generic entry point that gathers the per-site
 * branching in one place. That branching used to be a hand written switch
 * inside Match.service.ts, so adding a new site meant editing there too.
 */

import { virusBetMatchFetcherMain } from "./virusbet-match-fetcher.js";
import { betistMatchFetcherMain } from "./betist-match-fetcher.js";
import { mavibetMatchFetcherMain } from "./mavibet-match-fetcher.js";

import { EPanelSite } from "@Panel/Constants";

interface IFetchOptions {
  /** Only these sports (key or id). Falls back to MATCH_SPORTS, then to all. */
  sports?: string;

  /** Date window; applied after fetching. */
  dateFilter?: { dates?: string[]; from?: string; to?: string };

  /** false -> do not write the JSON file, just return the data. */
  write?: boolean;

  /** Override the default output file. */
  outputFile?: string;
}

type Fetcher = (siteUrl: string, options?: IFetchOptions) => Promise<any>;

/**
 * Site -> fetcher mapping. Adding a new site = one line here.
 */
const FETCHERS: Record<EPanelSite, Fetcher> = {
  [EPanelSite.VIRUS_BET]: virusBetMatchFetcherMain,
  [EPanelSite.BETIST]: betistMatchFetcherMain,
  [EPanelSite.MAVI_BET]: mavibetMatchFetcherMain,
};

const isSupportedSite = (site: string): site is EPanelSite =>
  Object.prototype.hasOwnProperty.call(FETCHERS, site);

/**
 * Fetches the matches of one site.
 *
 * @throws For an unsupported site -- failing loudly rather than silently
 *         doing nothing keeps misconfiguration visible.
 */
const fetchSiteMatches = async (
  site: string,
  siteUrl: string,
  options: IFetchOptions = {}
) => {
  if (!isSupportedSite(site)) {
    throw new Error(`Unsupported site: ${site}`);
  }

  return FETCHERS[site](siteUrl, options);
};

export {
  virusBetMatchFetcherMain,
  betistMatchFetcherMain,
  mavibetMatchFetcherMain,
  fetchSiteMatches,
  isSupportedSite,
  FETCHERS,
};

export type { IFetchOptions };
