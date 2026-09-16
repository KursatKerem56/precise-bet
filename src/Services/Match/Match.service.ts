/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs/promises";

import { compareMatchTimesMain } from "./compare-match-times";

import { getSites } from "@Panel";

import {
  virusBetMatchFetcherMain,
  betistMatchFetcherMain,
  mavibetMatchFetcherMain,
} from "@Match/Fetchers";

import { Match } from "@Match/Models";

import { EMatchSport } from "@Match/Constants";
import { EPanelSite } from "@Panel/Constants";

const saveMatches = async (site: EPanelSite) => {
  const jsonFilePath = `./${site.toLowerCase()}-matches.json`;

  const fileContent = await fs.readFile(jsonFilePath, "utf-8");

  const matchesRaw = JSON.parse(fileContent);

  const foundSite = (await getSites()).find((_site) => _site.site === site);

  if (!foundSite) return;

  await Match.deleteMany({ site: foundSite._id.toString() });

  const matchesWillBeSaved = [];

  for (const sportKey of Object.keys(matchesRaw) as Array<
    keyof typeof matchesRaw
  >) {
    const sport = matchesRaw[sportKey];
    const data = {
      site: foundSite._id.toString(),
      sport:
        sportKey === "FUTBOL"
          ? EMatchSport.FOOTBALL
          : sportKey === "BASKETBOL"
            ? EMatchSport.BASKETBALL
            : sportKey === "VOLEYBOL"
              ? EMatchSport.VOLLEYBALL
              : EMatchSport.TENNIS,
      leagues: [] as Array<{
        league: string | number | symbol;
        dates: Array<{
          date: string | number | symbol;
          matches: Array<{
            home: any;
            away: any;
            time: any;
          }>;
        }>;
      }>,
    };
    for (const leagueKey of Object.keys(sport) as Array<keyof typeof sport>) {
      const league = sport[leagueKey];
      const leagueData = {
        league: leagueKey,
        dates: [] as Array<{
          date: string | number | symbol;
          matches: Array<{
            home: any;
            away: any;
            time: any;
          }>;
        }>,
      };
      for (const dateKey of Object.keys(league) as Array<keyof typeof league>) {
        const date = league[dateKey];
        const dateData = {
          date: dateKey,
          matches: [] as Array<{
            home: any;
            away: any;
            time: any;
          }>,
        };
        for (const match of date) {
          const matchData = {
            home: match.home,
            away: match.away,
            time: match.time,
          };
          dateData.matches.push(matchData);
        }
        leagueData.dates.push(dateData);
      }
      data.leagues.push(leagueData);
    }
    matchesWillBeSaved.push(data);
  }
  for await (const matchData of matchesWillBeSaved) {
    await Match.create(matchData);
  }
};

const REFETCH_INTERVAL_MS = 1000 * 60 * 2;

const fetchSite = async (site: { site: EPanelSite; link: string }) => {
  console.log(`Initializing match fetcher for site: ${site.site}`);

  switch (site.site) {
    case EPanelSite.VIRUS_BET:
      await virusBetMatchFetcherMain(site.link);
      await saveMatches(site.site);
      break;
    case EPanelSite.BETIST:
      await betistMatchFetcherMain(site.link);
      await saveMatches(site.site);
      break;
    case EPanelSite.MAVI_BET:
      await mavibetMatchFetcherMain(site.link);
      await saveMatches(site.site);
      break;
    default:
      console.log(`No match fetcher defined for site: ${site.site}`);
  }
};

const compareAndReschedule = async () => {
  try {
    await compareMatchTimesMain();
  } catch (error) {
    console.error(
      "compareMatchTimesMain failed:",
      error instanceof Error ? error.message : error
    );
  } finally {
    // Bu satır HER durumda çalışmalı; aksi halde tek bir hata döngüyü
    // kalıcı olarak durdurur ve sunucu bir daha veri çekmez.
    setTimeout(initMatchFetchers, REFETCH_INTERVAL_MS);
  }
};

const initMatchFetchers = async () => {
  try {
    const sites = await getSites();

    // Bir sitenin çekicisi patlarsa (ör. Cloudflare 502) diğerleri yarıda
    // kalmasın; allSettled ile her site kendi başına değerlendiriliyor.
    const results = await Promise.allSettled(sites.map(fetchSite));

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `Match fetcher failed for site ${sites[index].site}:`,
          result.reason instanceof Error ? result.reason.message : result.reason
        );
      }
    });
  } catch (error) {
    console.error(
      "initMatchFetchers cycle failed:",
      error instanceof Error ? error.message : error
    );
  } finally {
    // Karşılaştırma ve sonraki tur, sunucu açılışını bloklamasın diye
    // bu tick'in dışına alınıyor.
    setTimeout(compareAndReschedule, 0);
  }
};

const getMatches = async () => {
  const sites = await getSites();

  const matchesBySite: Record<string, any[]> = {};

  for await (const site of sites) {
    const matches = await Match.find({ site: site._id.toString() });
    matchesBySite[site.site] = matches;
  }

  return matchesBySite;
};

const getComparedMatches = async () => {
  //   const jsonFilePath = `./${site.toLowerCase()}-matches.json`;

  // const fileContent = await fs.readFile(jsonFilePath, "utf-8");

  // const matchesRaw = JSON.parse(fileContent);

  const jsonFilePath = `./match-times-diff.json`;
  const fileContent = await fs.readFile(jsonFilePath, "utf-8");
  const fileRaw = JSON.parse(fileContent);

  return fileRaw;
};

export { initMatchFetchers, getMatches, getComparedMatches };
