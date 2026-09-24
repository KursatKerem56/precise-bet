/**
 * TARIH / SAAT NORMALIZASYONU VE KARSILASTIRMASI
 *
 * Saat karsilastirmasi HER ZAMAN tek bir epoch sayisi uzerinden yapilir.
 * Sadece "HH:MM" string'i karsilastirmak 23:50 ile 00:10 arasini 23 saat
 * 40 dk fark sanardi; oysa gercek fark 20 dakikadir.
 */

import { MATCH_CONFIG } from "./config.js";

/** Europe/Istanbul = UTC+3 (yaz saati uygulanmiyor). */
export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 180;

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})/;

/**
 * "2026-09-18" + "20:00" -> epoch ms (yerel saat UTC+offset kabul edilerek).
 *
 * Saat yoksa null doner -- UYDURMAZ. Cagiran taraf saatsiz kaydi
 * "karsilastirilamaz" olarak isler.
 */
export function toEpochMs(
  date,
  time,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES
) {
  const d = DATE_RE.exec(String(date ?? ""));
  const t = TIME_RE.exec(String(time ?? ""));
  if (!d || !t) return null;

  const hour = +t[1];
  const minute = +t[2];
  if (hour > 23 || minute > 59) return null;

  return (
    Date.UTC(+d[1], +d[2] - 1, +d[3], hour, minute) - offsetMinutes * MINUTE_MS
  );
}

/** Sadece tarihin (saatsiz) epoch karsiligi; tarih kovalari icin. */
export function dateToEpochMs(date) {
  const d = DATE_RE.exec(String(date ?? ""));
  return d ? Date.UTC(+d[1], +d[2] - 1, +d[3]) : null;
}

/** "2026-09-18" + 1 gun -> "2026-09-19". Gecersiz tarihte null. */
export function dateKeyOffset(date, days) {
  const base = dateToEpochMs(date);
  if (base == null) return null;
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Bir mac icin normalize edilmis zaman bilgisi uretir.
 * Bu deger mac nesnesinde SAKLANIR; tekrar tekrar parse edilmez.
 */
export function normalizeTimestamp(date, time, offsetMinutes) {
  return {
    date,
    time: time ?? null,
    epoch: toEpochMs(date, time, offsetMinutes),
    dateEpoch: dateToEpochMs(date),
  };
}

/** Iki epoch arasindaki farki DAKIKA olarak verir (b - a). */
export function calculateTimeDifference(epochA, epochB) {
  if (epochA == null || epochB == null) return null;
  return Math.round((epochB - epochA) / MINUTE_MS);
}

/**
 * Iki macin saatlerini karsilastirir.
 *
 * @returns {{
 *   diffMinutes: number|null,
 *   comparable: boolean,
 *   isDifferent: boolean,
 *   plausible: boolean
 * }}
 *
 * `plausible` = bu iki kayit AYNI macin iki farkli gosterimi OLABILIR mi?
 * Farkli gunlerdeki kayitlar icin saat farki makul bir gece yarisi
 * kaymasini asiyorsa (varsayilan 12 saat) bu iki kayit ayni mac DEGILDIR.
 * Gercek veride bu kontrol olmadan "ayni takimlarin ertesi gunku baska
 * maci" 1380 dakikalik "saat farki" olarak raporlaniyordu.
 */
export function compareMatchTimes(a, b, options = {}) {
  const toleranceMinutes =
    options.toleranceMinutes ?? MATCH_CONFIG.toleranceMinutes;
  const maxAdjacent =
    options.maxAdjacentDayDiffMinutes ?? MATCH_CONFIG.maxAdjacentDayDiffMinutes;

  const diffMinutes = calculateTimeDifference(a.epoch, b.epoch);

  if (diffMinutes == null) {
    // Saat bilgisi eksik: eleme yapma, ama "farkli" de deme.
    return {
      diffMinutes: null,
      comparable: false,
      isDifferent: false,
      plausible: true,
    };
  }

  const sameDay = a.date === b.date;
  const plausible = sameDay || Math.abs(diffMinutes) <= maxAdjacent;

  return {
    diffMinutes,
    comparable: true,
    isDifferent: Math.abs(diffMinutes) > toleranceMinutes,
    plausible,
  };
}
