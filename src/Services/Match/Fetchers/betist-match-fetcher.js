/**
 * BETIST MAC CEKICI
 *
 * Cikti:  betist-matches.json
 *   { "FUTBOL": { "Ulke - Lig": { "2026-09-18": [
 *       { eventId, leagueId, home, away, time } ] } }, ... }
 *
 * ---------------------------------------------------------------------------
 * PROTOKOL
 *
 * Duz HTTPS. Iki tur istek var:
 *   1. GET /home.php   -> spor + lig menusu (HTML)
 *   2. GET /getdata.php?sec=ASIAN_LAYOUT&subsec=REQUEST_GET_SCHEME_EVENTS
 *      &league_id[]=...  -> o liglerin maclari (HTML icinde rev="{json}")
 *
 * ---------------------------------------------------------------------------
 * ESKI SURUME GORE NE DEGISTI
 *
 *   - Spor listesi ARTIK SABIT DEGIL. home.php menusu zaten tum sporlari
 *     iceriyordu; eskiden dordu haric hepsi atiliyordu. Artik menudeki her
 *     spor katalogla eslestiriliyor -> EK ISTEK OLMADAN 26 spor.
 *   - Lig gruplari sirayla degil, SINIRLI es zamanlilikla cekiliyor.
 *   - Ham `https.get` yerine keep-alive havuzlu HttpClient (TLS el sikismasi
 *     istek basina degil, baglanti basina).
 *   - 429/5xx icin exponential backoff'lu retry.
 */

import { HttpClient } from "./Core/http.js";
import { createLogger } from "./Core/logger.js";
import { createRateLimiter, chunkArray, mapWithConcurrency } from "./Core/async.js";
import { decodeHtmlEntities, stripTags, parseAttributes } from "./Core/text.js";
import { parseLocalDateTime } from "./Core/time.js";
import { runFetcher } from "./Core/runner.js";
import { resolveSport, resolveEnabledSportKeys } from "./Sports/catalog.js";

const SITE = "BETIST";

const OUTPUT_FILE = process.env.BETIST_OUTPUT || "betist-matches.json";

const CHUNK_SIZE = Number(process.env.BETIST_CHUNK_SIZE || 10);

/**
 * Es zamanli istek sayisi. 3 bilincli bir secim: seri calismaya gore
 * belirgin hizlanma sagliyor ama siteyi dovmuyor.
 */
const CONCURRENCY = Number(process.env.BETIST_CONCURRENCY || 3);

/** Istekler arasi asgari aralik (rate limit dostu olmak icin). */
const REQUEST_DELAY_MS = Number(process.env.BETIST_REQUEST_DELAY_MS || 150);

const REQUEST_TIMEOUT_MS = Number(process.env.BETIST_TIMEOUT_MS || 25000);

const RETRY_ATTEMPTS = Number(process.env.BETIST_RETRY_ATTEMPTS || 3);

/* =========================================================================
 * PARSING
 * ====================================================================== */

/**
 * home.php menusunden sporlari ve her sporun lig id'lerini cikarir.
 *
 * Menu duz bir <i> listesi: spor isaretcileri (class="b-check sport") ve lig
 * isaretcileri (class="b-check stage") ic ice DEGIL, arka arkaya geliyor.
 * Bu yuzden once spor isaretcilerinin konumlari bulunuyor, sonra iki spor
 * arasinda kalan blok o sporun ligleri sayiliyor.
 */
function parseSportMenu(html) {
  const markers = [];

  const tagRegex = /<i\b[^>]*>/gi;

  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const attrs = parseAttributes(match[0]);

    const idMatch = String(attrs.id || "").match(/^check__(\d+)$/);

    if (!idMatch) continue;

    const classes = new Set(
      String(attrs.class || "")
        .split(/\s+/)
        .filter(Boolean)
    );

    if (!classes.has("b-check") || !classes.has("sport")) continue;

    const after = html.slice(tagRegex.lastIndex, tagRegex.lastIndex + 2000);

    const nameMatch = after.match(
      /<span\b[^>]*class=["'][^"']*\bsport-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
    );

    markers.push({
      sportId: idMatch[1],
      name: nameMatch ? stripTags(nameMatch[1]) : `SPORT_${idMatch[1]}`,
      layoutSchemaCode: attrs.layout || "",
      start: match.index,
    });
  }

  return markers.map((sport, index) => {
    const end = index + 1 < markers.length ? markers[index + 1].start : html.length;

    const block = html.slice(sport.start, end);

    const leagueIds = [];

    const seen = new Set();

    const leagueRegex = /<i\b[^>]*>/gi;

    let leagueMatch;

    while ((leagueMatch = leagueRegex.exec(block)) !== null) {
      const attrs = parseAttributes(leagueMatch[0]);

      const idMatch = String(attrs.id || "").match(/^check__(\d+)$/);

      if (!idMatch) continue;

      const classes = new Set(
        String(attrs.class || "")
          .split(/\s+/)
          .filter(Boolean)
      );

      if (!classes.has("b-check") || !classes.has("stage")) continue;

      if (seen.has(idMatch[1])) continue;

      seen.add(idMatch[1]);
      leagueIds.push(idMatch[1]);
    }

    return { ...sport, leagueIds };
  });
}

/**
 * Yanit HTML'indeki rev="{...}" niteliklerinden mac kayitlarini cikarir.
 * rev her zaman mac JSON'u degildir; parse edilemeyen sessizce atlanir.
 */
function parseEventRecords(html) {
  const events = new Map();

  const revRegex = /\brev="([^"]+)"/g;

  let match;

  while ((match = revRegex.exec(html)) !== null) {
    const decoded = decodeHtmlEntities(match[1]);

    if (!decoded.startsWith("{") || !decoded.endsWith("}")) continue;

    try {
      const obj = JSON.parse(decoded);

      if (!obj?.mid || !obj?.event_start_time || !obj?.lid) continue;

      const key = String(obj.mid);

      if (!events.has(key)) events.set(key, obj);
    } catch {
      // rev niteligi her zaman event JSON'u tasimiyor.
    }
  }

  return [...events.values()];
}

function splitParticipants(eventName) {
  const value = String(eventName || "").trim();

  const index = value.indexOf(" - ");

  if (index === -1) return { home: value, away: "" };

  return {
    home: value.slice(0, index).trim(),
    away: value.slice(index + 3).trim(),
  };
}

function buildEventsUrl(baseUrl, leagueIds, layoutSchemaCode) {
  const url = new URL(`${baseUrl}/getdata.php`);

  url.searchParams.set("sec", "ASIAN_LAYOUT");
  url.searchParams.set("subsec", "REQUEST_GET_SCHEME_EVENTS");

  for (const leagueId of leagueIds) {
    url.searchParams.append("league_id[]", leagueId);
  }

  url.searchParams.set("layout_schema_code", layoutSchemaCode);
  url.searchParams.set("start", "");
  url.searchParams.set("end", "");
  url.searchParams.set("selected_date_period", "null");

  return url.toString();
}

/* =========================================================================
 * KESIF
 * ====================================================================== */

/**
 * Menudeki sporlari katalogla eslestirir.
 *
 * Tanimadigimiz sporlar (e-spor, politika vb.) ATLANIR ve tek bir satirda
 * raporlanir. Uydurma bir anahtarla ciktiya sizmalari, siteler arasi
 * karsilastirmayi bozardi.
 */
function selectSports(menu, enabledKeys, logger) {
  const targets = new Map();

  const unmapped = [];

  for (const item of menu) {
    const sport = resolveSport(item.name);

    if (!sport) {
      unmapped.push(item.name);
      continue;
    }

    if (enabledKeys && !enabledKeys.has(sport.key)) continue;

    if (!item.layoutSchemaCode) {
      logger.warn(`${sport.key}: layout_schema_code yok, atlaniyor.`);
      continue;
    }

    if (!item.leagueIds.length) continue;

    // Ayni katalog anahtarina birden fazla menu girdisi dusebilir
    // (orn. "Rugby" ve "Ragbi" -> RAGBI). Ikisi de cekilir, cikti birlesir.
    const list = targets.get(sport.key) ?? [];

    list.push({ ...item, sportKey: sport.key });

    targets.set(sport.key, list);
  }

  if (unmapped.length) {
    logger.debug(`katalogda olmayan spor atlandi: ${unmapped.join(", ")}`);
  }

  return targets;
}

/* =========================================================================
 * ANA AKIS
 * ====================================================================== */

/**
 * @param {string} siteUrl
 * @param {{ dateFilter?: object, write?: boolean, sports?: string }} [options]
 */
async function betistMatchFetcherMain(siteUrl, options = {}) {
  const logger = createLogger(SITE);

  const site = new URL(siteUrl);

  // Veri, ana alan adinda degil "bet." alt alan adinda duruyor.
  const baseUrl = `${site.protocol}//bet.${site.hostname}`;

  const enabledKeys = resolveEnabledSportKeys(options.sports);

  const http = new HttpClient({
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxSockets: CONCURRENCY + 1,
    retry: { attempts: RETRY_ATTEMPTS },
    rateLimiter: createRateLimiter(REQUEST_DELAY_MS),
    logger,
  });

  try {
    return await runFetcher({
      site: SITE,
      logger,
      outputFile: options.outputFile ?? OUTPUT_FILE,
      dateFilter: options.dateFilter,
      write: options.write,

      collect: async ({ output }) => {
        logger.info(`site=${siteUrl} data=${baseUrl}`);

        const home = await http.get(`${baseUrl}/home.php?domain=&options=`, {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          Referer: `${siteUrl}/betting`,
        });

        const menu = parseSportMenu(home.body);

        if (!menu.length) {
          throw new Error(
            "Spor menusu bulunamadi. Site HTML yapisi degismis olabilir."
          );
        }

        const targets = selectSports(menu, enabledKeys, logger);

        logger.info(
          `menude ${menu.length} spor, ${targets.size} tanesi hedefleniyor`
        );

        // Tum sporlarin lig gruplari TEK bir is kuyruguna aliniyor.
        // Spor spor ilerlemek yerine boyle yapmanin sebebi: kucuk sporlarda
        // (1-2 grup) es zamanlilik bos kalirdi; tek kuyrukta worker'lar
        // bastan sona dolu calisiyor.
        const tasks = [];

        for (const [sportKey, entries] of targets) {
          for (const entry of entries) {
            for (const leagueIds of chunkArray(entry.leagueIds, CHUNK_SIZE)) {
              tasks.push({ sportKey, entry, leagueIds });
            }
          }
        }

        logger.info(`${tasks.length} lig grubu cekilecek (es zamanli: ${CONCURRENCY})`);

        const results = await mapWithConcurrency(
          tasks,
          CONCURRENCY,
          async (task) => {
            const url = buildEventsUrl(
              baseUrl,
              task.leagueIds,
              task.entry.layoutSchemaCode
            );

            const response = await http.get(url, {
              Referer: `${siteUrl}/betting`,
              "X-Requested-With": "XMLHttpRequest",
            });

            return { task, events: parseEventRecords(response.body) };
          }
        );

        let failed = 0;

        for (const result of results) {
          if (result.status === "rejected") {
            // Tek bir grubun patlamasi digerlerini durdurmaz.
            failed++;

            logger.warn(`lig grubu alinamadi: ${result.reason.message.split("\n")[0]}`);

            continue;
          }

          const { task, events } = result.value;

          for (const event of events) {
            // Yanit bazen istenmeyen sporun maclarini da tasiyor.
            if (String(event.sport_id) !== String(task.entry.sportId)) continue;

            const { date, time } = parseLocalDateTime(event.event_start_time);

            const { home: homeTeam, away } = splitParticipants(event.event);

            output.add(task.sportKey, {
              eventId: event.mid,
              leagueId: event.lid,
              leagueName: event.league_name,
              countryName: event.country_name,
              home: homeTeam,
              away,
              date,
              time,
            });
          }
        }

        if (failed) {
          logger.warn(`${tasks.length} gruptan ${failed} tanesi alinamadi.`);
        }

        logger.info(
          `${http.stats.requests} istek, ${http.stats.retries} tekrar, ` +
            `${(http.stats.bytes / 1024 / 1024).toFixed(1)} MB`
        );
      },
    });
  } finally {
    http.close();
  }
}

export { betistMatchFetcherMain, parseSportMenu, parseEventRecords, splitParticipants };
