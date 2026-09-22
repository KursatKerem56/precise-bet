/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs/promises";

import { compareMatchTimesMain } from "./compare-match-times";

import { getSites } from "@Panel";

import { fetchSiteMatches, isSupportedSite } from "@Match/Fetchers";

// Spor anahtari -> normalized id cevrimi icin tek kaynak.
import { getSportByKey } from "@Match/Fetchers/Sports/catalog.js";

import { Match } from "@Match/Models";

import { EMatchSport } from "@Match/Constants";
import { EPanelSite } from "@Panel/Constants";

import logger from "@Utils/Logger";

/** Iki calisma arasindaki bekleme. */
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
    // ESKIDEN: ic ice ternary, bilinmeyen HER anahtari sessizce TENNIS'e
    // yaziyordu. Yeni sporlar eklenince bu, veriyi sessizce bozardi.
    // Artik katalogdan cozuluyor ve cozulemeyen anahtar ATLANIYOR.
    const sport = getSportByKey(sportKey);

    if (!sport) {
      logger.warn(`[${site}] katalogda olmayan spor anahtari atlandi: ${sportKey}`);
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
    // Bos sonuc icin mevcut kayitlari SILMIYORUZ; gecici bir cekim
    // basarisizligi kalici veri kaybina donusmemeli.
    logger.warn(`[${site}] kaydedilecek mac yok; mevcut kayitlar korunuyor.`);
    return;
  }

  await Match.deleteMany({ site: foundSite._id.toString() });

  // insertMany tek turda gider; eskiden mac grubu basina ayri create()
  // cagrisi yapiliyordu.
  await Match.insertMany(matchesWillBeSaved);
};

/** Ayni anda ikinci bir tur baslamasini engeller. */
let fetchInProgress = false;

let fetchTimer: NodeJS.Timeout | null = null;

const runMatchFetchers = async () => {
  const sites = await getSites();

  // Siteler birbirinden bagimsiz: biri patlarsa digerleri devam etsin.
  const results = await Promise.allSettled(
    sites.map(async (site) => {
      if (!isSupportedSite(site.site)) {
        logger.warn(`Fetcher tanimli degil: ${site.site}`);
        return;
      }

      logger.info(`Mac cekimi basliyor: ${site.site}`);

      await fetchSiteMatches(site.site, site.link);

      await saveMatches(site.site);

      logger.info(`Mac cekimi bitti: ${site.site}`);
    })
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.error(
        `Mac cekimi basarisiz: ${sites[index]?.site}`,
        result.reason
      );
    }
  });

  // Karsilastirma, cekimlerin bir kismi basarisiz olsa bile calissin:
  // elde olan dosyalarla anlamli sonuc ureten bir adim.
  try {
    await compareMatchTimesMain();
  } catch (error) {
    logger.error("Mac saati karsilastirmasi basarisiz", error);
  }
};

/**
 * Periyodik mac cekimini baslatir.
 *
 * ESKIDEN: `setTimeout(initMatchFetchers, 2dk)` cekim suresinden BAGIMSIZ
 * kuruluyordu; cekim 2 dakikadan uzun surerse turlar ust uste biniyordu.
 * Ayrica compareMatchTimesMain() hata atarsa yeniden kurma satirina hic
 * ulasilamiyor, dongu sessizce oluyordu.
 *
 * Artik: ayni anda tek tur, ve bir sonraki tur HER DURUMDA (hata dahil)
 * onceki tur BITTIKTEN sonra kuruluyor.
 */
const initMatchFetchers = async () => {
  if (fetchInProgress) {
    logger.warn("Onceki mac cekimi hala suruyor; bu tur atlandi.");
    return;
  }

  fetchInProgress = true;

  try {
    await runMatchFetchers();
  } catch (error) {
    logger.error("Mac cekim turu basarisiz", error);
  } finally {
    fetchInProgress = false;

    if (fetchTimer) clearTimeout(fetchTimer);

    fetchTimer = setTimeout(initMatchFetchers, FETCH_INTERVAL_MS);

    // Zamanlayici process'in kapanmasini engellemesin.
    fetchTimer.unref?.();
  }
};

/** Periyodik cekimi durdurur (test ve duzgun kapanma icin). */
const stopMatchFetchers = () => {
  if (fetchTimer) clearTimeout(fetchTimer);

  fetchTimer = null;
};

const getMatches = async () => {
  const sites = await getSites();

  const matchesBySite: Record<string, any[]> = {};

  // Siteler bagimsiz; sirayla beklemek yerine paralel sorgula.
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
