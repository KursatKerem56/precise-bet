/**
 * ADAY DARALTMA (CANDIDATE REDUCTION)
 *
 * Eski kod her macin adaylarini yalnizca "spor|tarih" kovasindan
 * aliyordu. Gercek veride bu, uc site icin 979.978 aday cifti (=3.9 milyon
 * bulanik takim karsilastirmasi) demekti ve tek kosu ~72 saniye suruyordu.
 *
 * Burada kovanin ustune bir de TAKIM ADI TERS INDEKSI (inverted index)
 * kuruluyor:
 *
 *     sport -> dateKey -> tokenPrefix -> [mac indeksleri]
 *
 * Bir mac icin aday havuzu, yalnizca AYNI SPOR + AYNI/KOMSU TARIH kovasinda
 * olup takim adlarindan en az bir ortak 3-harf oneki paylasan maclardir.
 *
 * Gercek veride olculdu:
 *   aday cifti   979.978 -> 43.501  (%4.4)
 *   dogru eslesme  2068  -> 2067    (%99.95 recall)
 *
 * Kaybedilen TEK eslesme zaten yanlis pozitifti ("CE Gramadense RS" ile
 * "Criciuma EC"), yani daraltma dogruluktan hic odun vermiyor.
 *
 * Neden token'in kendisi degil de ONEKI: siteler ayni adi biraz farkli
 * yaziyor (Nordsjalland/Nordsjaelland, Baracaldo/Barakaldo,
 * Slovakya/Slovakia, Zimbabve/Zimbabwe). Tam token esitligi bunlari
 * kaybederdi; 3 harflik onek yakaliyor.
 */

import { tokenize } from "./text.js";
import { normalizeTeamName } from "./team.js";
import { dateKeyOffset } from "./datetime.js";
import { MATCH_CONFIG, WEAK_TOKENS } from "./config.js";

/**
 * Bir macin blocking imzasini uretir: iki takim adinin token oneklerinin
 * kumesi.
 *
 * Zayif kelimeler ("City", "United", "Real") imzaya GIRMEZ: aksi halde
 * butun "... City" takimlari tek kovada toplanip daraltmayi anlamsiz
 * kilardi.
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
 * Bir mac listesi icin hiyerarsik indeks kurar.
 *
 * Yapisi:  Map<sport, Map<dateKey, Map<prefix, number[]>>>
 *
 * Boylece "FUTBOL / 2026-09-24" icin aday ararken basketbol maclari,
 * diger tarihler ve ortak token'i olmayan maclar HIC taranmaz.
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

    // Imzasi bos kalan mac (ornegin adlarin hepsi zayif kelime) hicbir
    // kovada gorunmezdi; ayri bir "imzasiz" listesine alip her sorguya
    // ekliyoruz ki sessizce kaybolmasin.
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
 * Bir mac icin aday indekslerini dondurur.
 *
 * SPOR -> TARIH KOVASI -> ORTAK TOKEN ONEKI sirasiyla daraltir; bu sira
 * kasitli: en ucuz ve en kesin eleme once yapilir.
 *
 * @returns {number[]} hedef listedeki aday indeksleri (tekil)
 */
export function findMatchCandidates(match, index, options = {}) {
  const dateToleranceDays =
    options.dateToleranceDays ?? MATCH_CONFIG.dateToleranceDays;

  // 1) SPOR -- farkli spor branslarinda asla aday aranmaz.
  const byDate = index.bySport.get(match.sport);
  if (!byDate) return [];

  const signature = blockingSignature(match, index.prefixLength);
  const found = new Set();

  // 2) TARIH -- ayni gun ve (gece yarisi kaymasi icin) komsu gunler.
  for (let offset = -dateToleranceDays; offset <= dateToleranceDays; offset++) {
    const dateKey =
      offset === 0 ? match.date : dateKeyOffset(match.date, offset);
    if (!dateKey) continue;

    const byPrefix = byDate.get(dateKey);
    if (!byPrefix) continue;

    // 3) TAKIM -- yalnizca ortak onek tasiyan maclar.
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
