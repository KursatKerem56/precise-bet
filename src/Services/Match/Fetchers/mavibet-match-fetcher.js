/**
 * MAVIBET MATCH FETCHER
 *
 * Output:  mavi_bet-matches.json  (the exact same shape as betist)
 *
 * ---------------------------------------------------------------------------
 * PROTOCOL
 *
 * WAMP v2 over WebSocket (the wamp.2.json subprotocol), with
 * permessage-deflate mandatory (the server only sends large responses
 * compressed).
 *
 *   HELLO -> WELCOME -> (session priming) -> REGISTER(topic) + CALL initialDump
 *
 * Without the priming steps the server rejects data requests with
 * "om.rpc.exception"; that is why primeSession() exists, not superstition.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED VERSUS THE OLD VERSION -- THE BIGGEST WIN IN THIS FILE
 *
 * The old flow, per sport, was:
 *     locations/{sportId}                      ->  ~70 countries
 *       tournaments/{sportId}/{locationId}     ->  1 request per country
 *         /sports#tournaments                  ->  1 request PER LEAGUE
 *         tournament-aggregator-.../{leagueId} ->  1-4 requests PER LEAGUE
 * For football that meant ~560-900 requests and a mandatory 80 ms wait per
 * league.
 *
 * Yet the server serves the same data on a SINGLE topic:
 *     sport-aggregator-main/{sportId}/default-event-info/NOT_LIVE/1
 * -> 1 request, 292 leagues / 1325 matches for football (the old method
 * found 740 matches).
 *
 * The trailing "1" is how many markets are requested per match; we do not
 * need the odds, so the lowest value is used (0 means UNLIMITED and times
 * out on football -- hence 1, NOT 0).
 *
 * The old league-by-league path was NOT deleted: if the bulk topic is
 * rejected we fall back to it automatically, so data keeps arriving even if
 * the server changes format.
 *
 * The sport list is no longer hardcoded either: 50 sports are discovered
 * from the "disciplinesV2" dump that primeSession already fetches (and used
 * to throw away). That tennis uses a different league tree is not baked into
 * the code either; it is read from the record's `showEventCategory` field.
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";

import { connectWebSocket } from "./Core/ws.js";
import { createLogger } from "./Core/logger.js";
import {
  createRateLimiter,
  mapWithConcurrency,
  withRetry,
  isTransientError,
} from "./Core/async.js";
import { formatEpochMs, DEFAULT_TIMEZONE } from "./Core/time.js";
import { runFetcher } from "./Core/runner.js";
import { resolveSport, resolveEnabledSportKeys } from "./Sports/catalog.js";

const SITE = "MAVI_BET";

const OUTPUT_FILE = process.env.MAVIBET_OUTPUT || "mavi_bet-matches.json";

const TENANT = process.env.MAVIBET_TENANT || "2007";

const LANG = "en";

const CALL_TIMEOUT_MS = Number(process.env.MAVIBET_CALL_TIMEOUT_MS || 20000);

/**
 * A SEPARATE and much longer timeout for the bulk sport dump.
 * The football dump measured ~17 s; the general 20 s limit was cutting this
 * request off almost every time.
 */
const BULK_TIMEOUT_MS = Number(process.env.MAVIBET_BULK_TIMEOUT_MS || 120000);

const CONCURRENCY = Number(process.env.MAVIBET_CONCURRENCY || 2);

const REQUEST_DELAY_MS = Number(process.env.MAVIBET_REQUEST_DELAY_MS || 80);

const RETRY_ATTEMPTS = Number(process.env.MAVIBET_RETRY_ATTEMPTS || 3);

/** 0 = unlimited. Only to bound the fallback (league-by-league) path. */
const MAX_LOCATIONS = Number(process.env.MAVIBET_MAX_LOCATIONS || 0);

const DEBUG_FILE = process.env.MAVIBET_DEBUG_FILE || "mavibet-debug.log";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const WAMP = {
  HELLO: 1,
  WELCOME: 2,
  ABORT: 3,
  ERROR: 8,
  SUBSCRIBE: 32,
  SUBSCRIBED: 33,
  CALL: 48,
  RESULT: 50,
  REGISTER: 64,
  REGISTERED: 65,
  INVOCATION: 68,
  YIELD: 70,
};

/* =========================================================================
 * WAMP CLIENT
 * ====================================================================== */

class MavibetClient {
  constructor({ wsUrl, origin, logger }) {
    this.wsUrl = wsUrl;
    this.origin = origin;
    this.logger = logger;

    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.clientId = crypto.randomBytes(32).toString("base64");
    this.sessionId = null;
    this.welcome = null;
    this.closedByUs = false;
    this.reconnecting = null;

    /** Every topic tried and its result; written to file when something goes wrong. */
    this.diagnostics = [];

    this.stats = { calls: 0, retries: 0, reconnects: 0 };
  }

  ctx() {
    return {
      v: "2",
      lang: LANG,
      tz: -180,
      cid: this.clientId,
      t: Math.floor(Date.now() / 1000),
    };
  }

  async connect() {
    this.ws = await connectWebSocket(this.wsUrl, {
      origin: this.origin,
      userAgent: USER_AGENT,
      subprotocol: "wamp.2.json",
      // The server sends large responses ONLY compressed.
      permessageDeflate: true,
      handshakeTimeoutMs: CALL_TIMEOUT_MS + 10000,
      extraHeaders: ["Cache-Control: no-cache", "Pragma: no-cache"],
      logger: this.logger,
    });

    this.ws.onText((text) => {
      let message;

      try {
        message = JSON.parse(text);
      } catch {
        return;
      }

      if (Array.isArray(message)) this.handle(message);
    });

    this.ws.onClose(() => {
      for (const [, pending] of this.pending) {
        const error = new Error("Connection closed.");
        error.retryable = true;
        pending.reject(error);
      }

      this.pending.clear();

      this.welcome?.reject(new Error("Connection closed while waiting for WELCOME."));
      this.welcome = null;
    });

    // A WAMP HELLO MUST have three elements, and the router will not open a
    // session without "roles"; if we send an incomplete one the following
    // messages are silently ignored.
    const hello = [
      WAMP.HELLO,
      "http://www.mavibet.com",
      {
        agent: "Wampy.js v6.2.2",
        roles: {
          publisher: {
            features: {
              subscriber_blackwhite_listing: true,
              publisher_exclusion: true,
              publisher_identification: true,
            },
          },
          subscriber: {
            features: {
              pattern_based_subscription: true,
              publication_trustlevels: true,
            },
          },
          caller: {
            features: {
              caller_identification: true,
              progressive_call_results: true,
              call_canceling: true,
              call_timeout: true,
            },
          },
          callee: {
            features: {
              caller_identification: true,
              call_trustlevels: true,
              pattern_based_registration: true,
              shared_registration: true,
            },
          },
        },
        authmethods: ["wampcra"],
        authid: "webapi-wampy",
      },
    ];

    // Nothing is sent before WELCOME arrives; early requests are silently
    // dropped by the router (the classic cause of empty output).
    const welcomePromise = new Promise((resolve, reject) => {
      this.welcome = { resolve, reject };

      setTimeout(
        () => reject(new Error("WELCOME timed out (the server did not open a session).")),
        CALL_TIMEOUT_MS
      );
    });

    this.ws.send(JSON.stringify(hello));

    this.sessionId = await welcomePromise;

    this.logger.info(`WAMP session opened (session ${this.sessionId}).`);
  }

  handle(message) {
    const [type] = message;

    if (type === WAMP.WELCOME) {
      this.welcome?.resolve(message[1]);
      this.welcome = null;
      return;
    }

    if (type === WAMP.ABORT) {
      this.welcome?.reject(
        new Error(
          `The server rejected the session (ABORT): ${JSON.stringify(message[2] ?? message[1] ?? "unknown")}`
        )
      );
      this.welcome = null;
      return;
    }

    if (type === WAMP.INVOCATION) {
      // A server push: we do not use its content but the protocol requires
      // an acknowledgement.
      try {
        this.ws.send(JSON.stringify([WAMP.YIELD, message[1], {}]));
      } catch {
        /* the connection may already be closed */
      }
      return;
    }

    if (
      type === WAMP.RESULT ||
      type === WAMP.REGISTERED ||
      type === WAMP.SUBSCRIBED
    ) {
      const pending = this.pending.get(message[1]);

      if (!pending) return;

      this.pending.delete(message[1]);

      pending.resolve(type === WAMP.RESULT ? (message[4] ?? {}) : message[2]);

      return;
    }

    if (type === WAMP.ERROR) {
      const pending = this.pending.get(message[2]);

      if (!pending) return;

      this.pending.delete(message[2]);

      // WAMP ERROR: [8, requestType, requestId, details, errorUri, args, kwargs]
      // The server's real explanation is in args/kwargs; the errorUri on its
      // own ("om.rpc.exception") says nothing.
      const extras = [];

      if (message[3] && Object.keys(message[3]).length) {
        extras.push(`details=${JSON.stringify(message[3])}`);
      }

      if (message[5]?.length) extras.push(`args=${JSON.stringify(message[5])}`);

      if (message[6] && Object.keys(message[6]).length) {
        extras.push(`kwargs=${JSON.stringify(message[6])}`);
      }

      pending.reject(
        new Error(
          `WAMP ERROR: ${message[4] ?? "unknown"}` +
            (extras.length ? ` | ${extras.join(" ")}` : "")
        )
      );
    }
  }

  request(buildFrame, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);

        const error = new Error("The request timed out.");
        error.retryable = true;
        reject(error);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        this.ws.send(JSON.stringify(buildFrame(id)));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);

        error.retryable = true;
        reject(error);
      }
    });
  }

  call(procedure, details = {}, timeoutMs) {
    return this.request(
      (id) => [WAMP.CALL, id, {}, procedure, [], { ...details, ctx: this.ctx() }],
      timeoutMs
    );
  }

  register(topic, timeoutMs) {
    return this.request((id) => [WAMP.REGISTER, id, {}, topic], timeoutMs);
  }

  subscribe(topic) {
    return this.request((id) => [WAMP.SUBSCRIBE, id, {}, topic]);
  }

  async reconnect() {
    if (this.closedByUs) throw new Error("The client was closed.");

    if (!this.reconnecting) {
      this.reconnecting = (async () => {
        this.stats.reconnects++;

        this.logger.warn("connection dropped, reconnecting...");

        try {
          this.ws?.close();
        } catch {
          /* already closed */
        }

        // A new session needs the priming steps again.
        await this.connect();
        await this.primeSession();

        this.logger.info("reconnected.");
      })().finally(() => {
        this.reconnecting = null;
      });
    }

    return this.reconnecting;
  }

  /**
   * A point-in-time dump of one topic: REGISTER first, then initialDump.
   * Errors are labelled so it is clear which step broke.
   */
  async #dumpOnce(topic, timeoutMs) {
    try {
      await this.register(topic, timeoutMs);
    } catch (error) {
      error.message = `[REGISTER failed] ${error.message}`;
      throw error;
    }

    let data;

    try {
      data = await this.call("/sports#initialDump", { topic }, timeoutMs);
    } catch (error) {
      error.message = `[initialDump failed] ${error.message}`;
      throw error;
    }

    return Array.isArray(data?.records) ? data.records : [];
  }

  /**
   * Takes a dump with retry and, if needed, a reconnect.
   *
   * The old version had NO retry at all; the "timeout" lines in
   * mavibet-debug.log meant those leagues were silently lost.
   */
  async dump(topic, { label = topic, timeoutMs = CALL_TIMEOUT_MS, attempts = RETRY_ATTEMPTS } = {}) {
    this.stats.calls++;

    try {
      const records = await withRetry(
        async (attempt) => {
          if (attempt > 1 && (!this.ws || this.ws.closed)) {
            await this.reconnect();
          }

          return this.#dumpOnce(topic, timeoutMs);
        },
        {
          attempts,
          baseDelayMs: 700,
          label,
          isRetryable: (error) => {
            const message = String(error?.message ?? "");

            // REGISTERing the same topic twice is a permanent error; there
            // is no point retrying it.
            if (/already|exists|registered/i.test(message)) return false;

            return isTransientError(error);
          },
          onRetry: ({ attempt, attempts: total, error }) => {
            this.stats.retries++;

            this.logger.warn(
              `${label} failed (${attempt}/${total}): ${error.message}`
            );
          },
        }
      );

      this.diagnostics.push({ label, topic, ok: true, records: records.length });

      return records;
    } catch (error) {
      this.diagnostics.push({ label, topic, ok: false, error: error.message });

      this.logger.debug(`${label}: ERROR ${error.message}`);

      // null instead of throwing: one topic blowing up must not stop the
      // whole fetch.
      return null;
    }
  }

  /**
   * SESSION PRIMING -- the same steps the browser performs on startup.
   * Skip them and the server rejects the following data requests.
   *
   * RETURNS: the "disciplinesV2" dump. This dump used to be fetched and
   * THROWN AWAY, even though it holds the id, name and league tree type of
   * 50 sports. Sport discovery is now FREE -- no extra request.
   */
  async primeSession() {
    const topics = [
      "disciplines/LIVE/NOT_VIRTUAL",
      "custom-events",
      "custom-sports",
      "disciplines/BOTH/BOTH",
      "disciplinesV2/BOTH/BOTH",
      "disciplines/NOT_LIVE/NOT_VIRTUAL",
    ].map(topicFor);

    try {
      await this.subscribe("/registrationDismissed");
    } catch (error) {
      this.logger.debug(`[prime] subscribe skipped: ${error.message}`);
    }

    for (const topic of topics) {
      try {
        await this.register(topic);
      } catch (error) {
        this.logger.debug(`[prime] register skipped (${topic}): ${error.message}`);
      }
    }

    try {
      await this.call("/sports#getSessionInfo", { lang: LANG });
      await this.call("/sports#configureFonts", {});
    } catch (error) {
      this.logger.debug(`[prime] session info skipped: ${error.message}`);
    }

    let disciplines = [];

    // The browser's order: disciplinesV2 first.
    for (const path of [
      "disciplinesV2/BOTH/BOTH",
      "disciplines/BOTH/BOTH",
      "disciplines/LIVE/NOT_VIRTUAL",
      "disciplines/NOT_LIVE/NOT_VIRTUAL",
      "custom-sports",
      "custom-events",
    ]) {
      try {
        const data = await this.call("/sports#initialDump", {
          topic: topicFor(path),
        });

        const records = Array.isArray(data?.records) ? data.records : [];

        if (!disciplines.length && records.length) disciplines = records;
      } catch (error) {
        this.logger.debug(`[prime] dump skipped (${path}): ${error.message}`);
      }
    }

    this.logger.info("session primed.");

    return disciplines;
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}

const topicFor = (path) => `/sports/${TENANT}/${LANG}/${path}`;

/* =========================================================================
 * SPORT DISCOVERY
 * ====================================================================== */

/**
 * Matches the SPORT records in the disciplines dump against the catalog.
 *
 * `showEventCategory` is a flag the site reports ITSELF: when true, that
 * sport's league tree goes through "event category" (WTA, Challenger,
 * ITF...) instead of country. This used to be hardcoded for tennis.
 */
function discoverSports(records, enabledKeys, logger) {
  const targets = [];

  const unmapped = [];

  for (const record of records) {
    if (!record || record._type !== "SPORT" || record.id == null) continue;

    // Virtual/simulated sports are not real matches.
    if (record.isVirtual || record.isSimulated) continue;

    if (record.hasMatches === false) continue;

    if (Number(record.numberOfUpcomingMatches ?? 0) <= 0) continue;

    const sport = resolveSport(record.name, record.shortName);

    if (!sport) {
      unmapped.push(record.name);
      continue;
    }

    if (enabledKeys && !enabledKeys.has(sport.key)) continue;

    targets.push({
      sportId: String(record.id),
      sportKey: sport.key,
      name: record.name,
      upcoming: Number(record.numberOfUpcomingMatches ?? 0),
      useEventCategory: record.showEventCategory === true,
    });
  }

  if (unmapped.length) {
    logger.debug(`skipped sports missing from the catalog: ${unmapped.join(", ")}`);
  }

  // Start with the big sports, so the concurrent workers do not end up
  // waiting on a single huge job at the end.
  targets.sort((a, b) => b.upcoming - a.upcoming);

  return targets;
}

/* =========================================================================
 * DATA FETCHING
 * ====================================================================== */

/**
 * Converts one MATCH record into the shared output model.
 * @returns {boolean} true when it was really added (duplicate/incomplete
 *          records return false)
 */
function addMatchRecord(output, sportKey, record) {
  const { date, time } = formatEpochMs(record.startTime, DEFAULT_TIMEZONE);

  return output.add(sportKey, {
    eventId: record.id,
    leagueId: record.parentId,
    // Prefer the short name without the season ("Turkiye Super Lig") and
    // fall back to the full name ("Turkiye Super Lig 2026/2027").
    leagueName: record.shortParentName || record.parentName,
    countryName: record.venueName || record.categoryName,
    home: record.homeParticipantName,
    away: record.awayParticipantName,
    date,
    time,
  });
}

/**
 * THE BULK PATH: every league and match of a sport in one dump.
 * @returns {number} how many matches were added, or -1 (topic rejected)
 */
async function fetchSportBulk(client, sport, output) {
  const records = await client.dump(
    topicFor(
      `sport-aggregator-main/${sport.sportId}/default-event-info/NOT_LIVE/1`
    ),
    {
      label: `${sport.sportKey} bulk`,
      timeoutMs: BULK_TIMEOUT_MS,
      // When the server is busy it returns "backend_timeout". One or two
      // retries with backoff are far cheaper than dropping to the
      // league-by-league fallback (measured: retry ~1 s, fallback ~100 s).
      attempts: 3,
    }
  );

  if (!records) return -1;

  let added = 0;

  for (const record of records) {
    if (record?._type !== "MATCH" || record.id == null) continue;

    if (String(record.sportId) !== sport.sportId) continue;

    if (addMatchRecord(output, sport.sportKey, record)) added++;
  }

  return added;
}

/* ---------------------------------------------------------------------------
 * THE FALLBACK PATH (the old behaviour)
 *
 * If the bulk topic is rejected we walk league by league. Slow, but it
 * works; if the server changes format this is all we have.
 * ------------------------------------------------------------------------ */

/** Several topic formats serve the same league's matches; try the lightest first. */
function tournamentTopicVariants(tournamentId) {
  return [
    {
      key: "main-1",
      topic: topicFor(
        `tournament-aggregator-main/${tournamentId}/default-event-info/NOT_LIVE/1`
      ),
    },
    {
      key: "main-0",
      topic: topicFor(
        `tournament-aggregator-main/${tournamentId}/default-event-info/NOT_LIVE/0`
      ),
    },
  ];
}

/**
 * Interprets the "number of upcoming matches" field safely.
 * A MISSING field is not treated as 0; only an explicit 0 is skipped.
 */
function hasUpcoming(record) {
  const value = record?.numberOfUpcomingMatches;

  if (value === undefined || value === null || value === "") return true;

  return Number(value) > 0;
}

/** Which league topic format works -- remembered on the first success. */
let workingVariant = null;

async function fetchSportByLeagues(client, sport, output, throttle, logger) {
  const branchTopic = sport.useEventCategory
    ? topicFor(`event-category-by-sport/${sport.sportId}/BOTH`)
    : topicFor(`locations/${sport.sportId}`);

  const branchRecords = await client.dump(branchTopic, {
    label: `${sport.sportKey} branches`,
  });

  if (!branchRecords) return 0;

  const wantedType = sport.useEventCategory ? "EVENT_CATEGORY" : "LOCATION";

  let branches = branchRecords
    .filter((r) => r?._type === wantedType && r.id != null && hasUpcoming(r))
    .map((r) => ({
      name: r.name ?? `BRANCH_${r.id}`,
      topic: sport.useEventCategory
        ? topicFor(`tournaments-by-event-category/${r.id}`)
        : topicFor(`tournaments/${sport.sportId}/${r.id}`),
    }));

  if (MAX_LOCATIONS > 0) branches = branches.slice(0, MAX_LOCATIONS);

  logger.info(`${sport.sportKey}: fallback path, ${branches.length} branches`);

  let added = 0;

  for (const branch of branches) {
    await throttle();

    const records = await client.dump(branch.topic, {
      label: `${sport.sportKey} league list ${branch.name}`,
    });

    if (!records) continue;

    const tournaments = records.filter(
      (r) => r?._type === "TOURNAMENT" && r.id != null && hasUpcoming(r)
    );

    for (const tournament of tournaments) {
      const variants = tournamentTopicVariants(tournament.id);

      const ordered = workingVariant
        ? [
            ...variants.filter((v) => v.key === workingVariant),
            ...variants.filter((v) => v.key !== workingVariant),
          ]
        : variants;

      for (const variant of ordered) {
        await throttle();

        const matchRecords = await client.dump(variant.topic, {
          label: `${sport.sportKey} league ${tournament.name} [${variant.key}]`,
          attempts: 2,
        });

        if (!matchRecords) continue;

        const matches = matchRecords.filter(
          (r) =>
            r?._type === "MATCH" &&
            r.id != null &&
            String(r.sportId) === sport.sportId
        );

        // A response that succeeds but CONTAINS NO MATCHES does not count as
        // "working"; otherwise we would lock onto a format that returns
        // nothing and collect every league empty.
        if (!matches.length) continue;

        if (workingVariant !== variant.key) {
          logger.info(`using the "${variant.key}" format for league data`);
          workingVariant = variant.key;
        }

        for (const record of matches) {
          if (addMatchRecord(output, sport.sportKey, record)) added++;
        }

        break;
      }
    }
  }

  return added;
}

/* =========================================================================
 * MAIN FLOW
 * ====================================================================== */

/**
 * @param {string} siteUrl
 * @param {{ dateFilter?: object, write?: boolean, sports?: string }} [options]
 */
async function mavibetMatchFetcherMain(siteUrl, options = {}) {
  const logger = createLogger(SITE);

  const found = String(siteUrl).match(/mavibet(\d+)\.com/);

  if (!found) {
    logger.error(
      `site URL not recognised (expected mavibet{N}.com): ${siteUrl}`
    );

    return null;
  }

  const number = found[1];

  // CAREFUL: the WebSocket Origin is the SPORTS subdomain, not the main
  // site. A wrong Origin silently yields an EMPTY result.
  const origin =
    process.env.MAVIBET_WS_ORIGIN || `https://sports2.mavibet${number}.com`;

  const wsUrl =
    process.env.MAVIBET_WS_URL || `wss://sportsapi.mavibet${number}.com/v2`;

  const enabledKeys = resolveEnabledSportKeys(options.sports);

  const throttle = createRateLimiter(REQUEST_DELAY_MS);

  const client = new MavibetClient({ wsUrl, origin, logger });

  try {
    return await runFetcher({
      site: SITE,
      logger,
      outputFile: options.outputFile ?? OUTPUT_FILE,
      dateFilter: options.dateFilter,
      write: options.write,

      collect: async ({ output }) => {
        logger.info(`site=https://www.mavibet${number}.com ws=${wsUrl}`);

        await client.connect();

        const disciplines = await client.primeSession();

        const targets = discoverSports(disciplines, enabledKeys, logger);

        if (!targets.length) {
          throw new Error(
            "The sport list came back empty; session priming may have failed."
          );
        }

        logger.info(
          `targeting ${targets.length} sports out of ${disciplines.length} records ` +
            `(concurrency: ${CONCURRENCY})`
        );

        // The concurrency here is 2: these dumps are very large (~22k records
        // for football) and more would push the memory peak up for nothing.
        const results = await mapWithConcurrency(
          targets,
          CONCURRENCY,
          async (sport) => {
            await throttle();

            const bulk = await fetchSportBulk(client, sport, output);

            if (bulk >= 0) {
              logger.info(`${sport.sportKey}: bulk dump -> ${bulk} matches`);
              return bulk;
            }

            logger.warn(
              `${sport.sportKey}: bulk dump rejected, walking league by league.`
            );

            return fetchSportByLeagues(client, sport, output, throttle, logger);
          }
        );

        const failed = results.filter((r) => r.status === "rejected");

        for (const result of failed) {
          logger.error(`could not fetch sport: ${result.reason.message}`);
        }

        logger.info(
          `${client.stats.calls} dumps, ${client.stats.retries} retries, ` +
            `${client.stats.reconnects} reconnects`
        );

        await writeDiagnostics(client, output, logger);
      },
    });
  } finally {
    client.close();
  }
}

/** Writes the failed topics to a file, so failures are never silent. */
async function writeDiagnostics(client, output, logger) {
  const failed = client.diagnostics.filter((d) => !d.ok);

  if (!failed.length) return;

  const report = [
    `mavibet diagnostics report - ${new Date().toISOString()}`,
    `WS: ${client.wsUrl}`,
    `Origin: ${client.origin}`,
    `tried: ${client.diagnostics.length}, failed: ${failed.length}, ` +
      `matches collected: ${output.total}`,
    "",
    ...failed.map((d) => `ERROR ${d.error}\n      ${d.topic}`),
  ].join("\n");

  try {
    await fs.writeFile(DEBUG_FILE, `${report}\n`, "utf8");

    logger.warn(`${failed.length} requests failed; details: ${DEBUG_FILE}`);
  } catch (error) {
    logger.warn(`could not write the diagnostics report: ${error.message}`);
  }
}

export { mavibetMatchFetcherMain, MavibetClient, discoverSports, topicFor };
