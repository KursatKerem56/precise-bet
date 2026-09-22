/**
 * Tarih/saat donusumleri.
 *
 * Uc site zamani UC FARKLI birimde veriyor:
 *   betist   : "2026-09-18 20:00:00" (site yerel saati, Europe/Istanbul)
 *   virusbet : unix SANIYE
 *   mavibet  : unix MILISANIYE
 *
 * Ciktida hepsi Turkiye saatine gore "YYYY-MM-DD" + "HH:MM" olmali; aksi
 * halde saat karsilastirici (compare-match-times) ayni maci farkli saatte
 * gorur ve sahte "fark" uretirdi.
 *
 * Intl.DateTimeFormat kurulumu pahalidir (maç basina yeniden kurmak binlerce
 * kez tekrarlanan bir maliyet); bu yuzden zaman dilimi basina onbellekleniyor.
 */

const DEFAULT_TIMEZONE = "Europe/Istanbul";

const UNKNOWN = Object.freeze({ date: "UNKNOWN_DATE", time: "" });

const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    formatterCache.set(timeZone, formatter);
  }

  return formatter;
}

/**
 * epoch ms -> { date, time } (verilen zaman diliminde).
 *
 * DIKKAT: `Number(null)` ve `Number("")` sifir dondurur. Bunlari elemezsek
 * startTime alani eksik olan bir kayit sessizce "1970-01-01" tarihine
 * duserdi -- yani bozuk veri, gecerli veri gibi gorunurdu.
 */
function formatEpochMs(epochMs, timeZone = DEFAULT_TIMEZONE) {
  if (epochMs === null || epochMs === undefined || epochMs === "") {
    return UNKNOWN;
  }

  const value = Number(epochMs);

  if (!Number.isFinite(value)) return UNKNOWN;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return UNKNOWN;

  const parts = getFormatter(timeZone).formatToParts(date);

  const pick = (type) => parts.find((part) => part.type === type)?.value;

  const year = pick("year");

  if (!year) return UNKNOWN;

  return {
    date: `${year}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}`,
  };
}

/** epoch saniye -> { date, time }. */
function formatEpochSeconds(epochSeconds, timeZone = DEFAULT_TIMEZONE) {
  if (epochSeconds === null || epochSeconds === undefined || epochSeconds === "") {
    return UNKNOWN;
  }

  const value = Number(epochSeconds);

  if (!Number.isFinite(value)) return UNKNOWN;

  return formatEpochMs(value * 1000, timeZone);
}

/**
 * "YYYY-MM-DD HH:MM[:SS]" -> { date, time }.
 *
 * Deger zaten site yerel saatinde geldigi icin zaman dilimi donusumu
 * YAPILMIYOR; Date'e cevirmek sunucunun TZ'sine gore kaydirirdi.
 */
function parseLocalDateTime(value) {
  const match = String(value ?? "").match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?/
  );

  if (!match) return UNKNOWN;

  return { date: match[1], time: match[2] };
}

export {
  DEFAULT_TIMEZONE,
  formatEpochMs,
  formatEpochSeconds,
  parseLocalDateTime,
};
