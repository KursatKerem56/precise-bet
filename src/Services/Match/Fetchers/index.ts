/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Fetcher'larin dis yuzu.
 *
 * Mevcut `*MatchFetcherMain(siteUrl)` imzalari AYNEN korunuyor -- cagiran
 * kodun (Match.service.ts) degismesi gerekmiyor.
 *
 * Ustune, siteye gore dallanmayi tek yerde toplayan generic bir giris
 * ekleniyor. Eskiden bu dallanma Match.service.ts icinde elle yazilmis bir
 * switch'ti; yeni bir site eklemek orayi da degistirmeyi gerektiriyordu.
 */

import { virusBetMatchFetcherMain } from "./virusbet-match-fetcher.js";
import { betistMatchFetcherMain } from "./betist-match-fetcher.js";
import { mavibetMatchFetcherMain } from "./mavibet-match-fetcher.js";

import { EPanelSite } from "@Panel/Constants";

interface IFetchOptions {
  /** Yalnizca bu sporlar (key veya id). Verilmezse MATCH_SPORTS, o da yoksa hepsi. */
  sports?: string;

  /** Tarih penceresi; cekim sonrasi uygulanir. */
  dateFilter?: { dates?: string[]; from?: string; to?: string };

  /** false -> JSON dosyasina yazma, yalnizca veriyi dondur. */
  write?: boolean;

  /** Varsayilan cikti dosyasini gecersiz kil. */
  outputFile?: string;
}

type Fetcher = (siteUrl: string, options?: IFetchOptions) => Promise<any>;

/**
 * Site -> fetcher eslemesi. Yeni bir site eklemek = buraya bir satir.
 */
const FETCHERS: Record<EPanelSite, Fetcher> = {
  [EPanelSite.VIRUS_BET]: virusBetMatchFetcherMain,
  [EPanelSite.BETIST]: betistMatchFetcherMain,
  [EPanelSite.MAVI_BET]: mavibetMatchFetcherMain,
};

const isSupportedSite = (site: string): site is EPanelSite =>
  Object.prototype.hasOwnProperty.call(FETCHERS, site);

/**
 * Bir sitenin maclarini ceker.
 *
 * @throws Desteklenmeyen site icin -- sessizce hicbir sey yapmaktansa
 *         acik hata vermek, yanlis yapilandirmayi gorunur kilar.
 */
const fetchSiteMatches = async (
  site: string,
  siteUrl: string,
  options: IFetchOptions = {}
) => {
  if (!isSupportedSite(site)) {
    throw new Error(`Desteklenmeyen site: ${site}`);
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
