/**
 * BETIST MATCH FETCHER
 *
 * Output:  betist-matches.json
 *   { "FUTBOL": { "Ulke - Lig": { "2026-09-18": [
 *       { eventId, leagueId, home, away, time } ] } }, ... }
 *
 * ---------------------------------------------------------------------------
 * PROTOCOL
 *
 * Plain HTTPS. There are two kinds of request:
 *   1. GET /home.php   -> the sport + league menu (HTML)
 *   2. GET /getdata.php?sec=ASIAN_LAYOUT&subsec=REQUEST_GET_SCHEME_EVENTS
 *      &league_id[]=...  -> the matches of those leagues (rev="{json}" in HTML)
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED VERSUS THE OLD VERSION
 *
 *   - The sport list is NO LONGER HARDCODED. The home.php menu already
 *     contained every sport; previously all but four were thrown away. Now
 *     every sport in the menu is matched against the catalog -> 26 sports
 *     WITHOUT ANY EXTRA REQUEST.
 *   - League groups are fetched with BOUNDED concurrency instead of serially.
 *   - HttpClient with a keep-alive pool instead of a raw `https.get` (one TLS
 *     handshake per connection, not per request).
 *   - Retry with exponential backoff for 429/5xx.
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
 * Number of concurrent requests. 3 is a deliberate choice: clearly faster
 * than running serially without hammering the site.
 */
const CONCURRENCY = Number(process.env.BETIST_CONCURRENCY || 3);

/** Minimum gap between requests (to stay rate limit friendly). */
const REQUEST_DELAY_MS = Number(process.env.BETIST_REQUEST_DELAY_MS || 150);

const REQUEST_TIMEOUT_MS = Number(process.env.BETIST_TIMEOUT_MS || 25000);

const RETRY_ATTEMPTS = Number(process.env.BETIST_RETRY_ATTEMPTS || 3);

/* =========================================================================
 * PARSING
 * ====================================================================== */

/**
 * Extracts the sports and each sport's league ids from the home.php menu.
 *
 * The menu is a flat <i> list: the sport markers (class="b-check sport") and
 * the league markers (class="b-check stage") are NOT nested, they follow one
 * another. So the positions of the sport markers are found first, then the
 * block between two sports is taken as that sport's leagues.
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
 * Extracts match records from the rev="{...}" attributes in the response
 * HTML. rev does not always carry match JSON; whatever fails to parse is
 * skipped silently.
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
      // The rev attribute does not always carry event JSON.
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
 * DISCOVERY
 * ====================================================================== */

/**
 * Matches the sports in the menu against the catalog.
 *
 * Sports we do not know (esports, politics and so on) are SKIPPED and
 * reported in a single line. Letting them leak into the output under a made
 * up key would break the cross-site comparison.
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
      logger.warn(`${sport.key}: no layout_schema_code, skipping.`);
      continue;
    }

    if (!item.leagueIds.length) continue;

    // Several menu entries can map to the same catalog key (e.g. "Rugby"
    // and "Ragbi" -> RAGBI). Both are fetched and the output is merged.
    const list = targets.get(sport.key) ?? [];

    list.push({ ...item, sportKey: sport.key });

    targets.set(sport.key, list);
  }

  if (unmapped.length) {
    logger.debug(`skipped sports missing from the catalog: ${unmapped.join(", ")}`);
  }

  return targets;
}

/* =========================================================================
 * MAIN FLOW
 * ====================================================================== */

/**
 * @param {string} siteUrl
 * @param {{ dateFilter?: object, write?: boolean, sports?: string }} [options]
 */
async function betistMatchFetcherMain(siteUrl, options = {}) {
  const logger = createLogger(SITE);

  const site = new URL(siteUrl);

  // The data lives on the "bet." subdomain, not on the main domain.
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
            "Sport menu not found. The site's HTML structure may have changed."
          );
        }

        const targets = selectSports(menu, enabledKeys, logger);

        logger.info(
          `${menu.length} sports in the menu, ${targets.size} of them targeted`
        );

        // The league groups of all sports go into ONE work queue. The reason
        // for not walking sport by sport: on small sports (1-2 groups) the
        // concurrency would sit idle; with a single queue the workers stay
        // busy from start to finish.
        const tasks = [];

        for (const [sportKey, entries] of targets) {
          for (const entry of entries) {
            for (const leagueIds of chunkArray(entry.leagueIds, CHUNK_SIZE)) {
              tasks.push({ sportKey, entry, leagueIds });
            }
          }
        }

        logger.info(`fetching ${tasks.length} league groups (concurrency: ${CONCURRENCY})`);

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
            // One group blowing up does not stop the others.
            failed++;

            logger.warn(`could not fetch league group: ${result.reason.message.split("\n")[0]}`);

            continue;
          }

          const { task, events } = result.value;

          for (const event of events) {
            // The response sometimes carries matches of an unwanted sport too.
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
          logger.warn(`${failed} of ${tasks.length} groups could not be fetched.`);
        }

        logger.info(
          `${http.stats.requests} requests, ${http.stats.retries} retries, ` +
            `${(http.stats.bytes / 1024 / 1024).toFixed(1)} MB`
        );
      },
    });
  } finally {
    http.close();
  }
}

export { betistMatchFetcherMain, parseSportMenu, parseEventRecords, splitParticipants };
