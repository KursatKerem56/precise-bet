/**
 * VIRUSBET MATCH FETCHER
 *
 * Output:  virus_bet-matches.json  (the exact same shape as betist)
 *
 * ---------------------------------------------------------------------------
 * PROTOCOL
 *
 * Virusbet runs on the BetConstruct "swarm" backend. The data does not come
 * over plain HTTP but as JSON commands over a single WebSocket:
 *
 *   wss://eu-swarm-newm.virusbettr{N}.com/   (Origin: https://www.virusbettr{N}.com)
 *
 *   1. {"command":"request_session","params":{...}}   (NO login required)
 *   2. {"command":"get","params":{"source":"betting","what":{...},"where":{...}}}
 *      -> data.data.sport[id].region[id].competition[id].game[id]
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED VERSUS THE OLD VERSION
 *
 *   - The sport list is NOT HARDCODED. Four sport_ids used to be baked into
 *     the code; swarm already serves the whole sport tree. Now a single query
 *     discovers 50+ sports and matches them against the catalog.
 *   - The league list took a separate query PER SPORT (N requests). Now ONE
 *     query brings the league tree of every sport plus the match counts
 *     (~56 KB).
 *   - League groups are fetched with BOUNDED concurrency over one connection
 *     instead of serially (swarm supports concurrent rids).
 *   - If the connection drops it reconnects automatically and carries on;
 *     previously every pending request was rejected and the site returned
 *     completely empty.
 *   - The RFC 6455 client moved to Core/ws.js (shared with mavibet).
 */

import crypto from "node:crypto";

import { connectWebSocket } from "./Core/ws.js";
import { createLogger } from "./Core/logger.js";
import {
  createRateLimiter,
  chunkArray,
  mapWithConcurrency,
  withRetry,
} from "./Core/async.js";
import { formatEpochSeconds, DEFAULT_TIMEZONE } from "./Core/time.js";
import { runFetcher } from "./Core/runner.js";
import { resolveSport, resolveEnabledSportKeys } from "./Sports/catalog.js";

const SITE = "VIRUS_BET";

const OUTPUT_FILE = process.env.VIRUSBET_OUTPUT || "virus_bet-matches.json";

const SITE_ID = Number(process.env.VIRUSBET_SITE_ID || 1476);

const CHUNK_SIZE = Number(process.env.VIRUSBET_CHUNK_SIZE || 20);

const CONCURRENCY = Number(process.env.VIRUSBET_CONCURRENCY || 3);

const REQUEST_DELAY_MS = Number(process.env.VIRUSBET_REQUEST_DELAY_MS || 120);

const CALL_TIMEOUT_MS = Number(process.env.VIRUSBET_CALL_TIMEOUT_MS || 30000);

const RETRY_ATTEMPTS = Number(process.env.VIRUSBET_RETRY_ATTEMPTS || 3);

// On EC2 the IPv6 route/DNS preference can break the WebSocket connection.
const IP_FAMILY = Number(process.env.VIRUSBET_IP_FAMILY || 4);

const LANGUAGE = "en";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/** Games visible before the match starts (prematch). */
const PREMATCH_GAME_FILTER = {
  "@or": [{ visible_in_prematch: 1 }, { type: { "@in": [0, 2] } }],
};

/* =========================================================================
 * SWARM CLIENT
 * ====================================================================== */

class SwarmClient {
  constructor({ wsUrl, origin, logger }) {
    this.wsUrl = wsUrl;
    this.origin = origin;
    this.logger = logger;

    this.ws = null;
    this.pending = new Map();
    this.sessionId = null;
    this.closedByUs = false;

    /** Only one reconnect attempt may be in flight at a time. */
    this.reconnecting = null;

    this.stats = { calls: 0, retries: 0, reconnects: 0 };
  }

  static newRid() {
    return crypto.randomBytes(4).toString("hex");
  }

  async connect() {
    this.ws = await connectWebSocket(this.wsUrl, {
      origin: this.origin,
      userAgent: USER_AGENT,
      family: IP_FAMILY,
      // permessage-deflate is DELIBERATELY not offered: swarm works fine
      // uncompressed, which keeps us out of the decoding layer entirely.
      permessageDeflate: false,
      handshakeTimeoutMs: CALL_TIMEOUT_MS,
      logger: this.logger,
    });

    this.ws.onText((text) => {
      let message;

      try {
        message = JSON.parse(text);
      } catch {
        // Malformed JSON must not stop the whole stream.
        return;
      }

      const rid = message?.rid;

      // Messages without a rid are subscription pushes; we do not use them.
      if (!rid) return;

      const pending = this.pending.get(rid);

      if (!pending) return;

      this.pending.delete(rid);

      if (message.code !== 0) {
        pending.reject(
          new Error(
            `swarm error code=${message.code} msg=${JSON.stringify(message.msg ?? message.data ?? "")}`
          )
        );

        return;
      }

      pending.resolve(message.data);
    });

    this.ws.onClose(() => {
      // Reject the pending requests marked as "transient" so the retry
      // layer considers them worth another attempt.
      for (const [, pending] of this.pending) {
        const error = new Error("Connection closed.");
        error.retryable = true;
        pending.reject(error);
      }

      this.pending.clear();
    });

    await this.requestSession();
  }

  /** Re-establishes a dropped connection, once. */
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

        await this.connect();

        this.logger.info("reconnected.");
      })().finally(() => {
        this.reconnecting = null;
      });
    }

    return this.reconnecting;
  }

  #sendOnce(command, params) {
    const rid = SwarmClient.newRid();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);

        const error = new Error(`the "${command}" request timed out.`);
        error.retryable = true;
        reject(error);
      }, CALL_TIMEOUT_MS);

      this.pending.set(rid, {
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
        this.ws.send(JSON.stringify({ command, params, rid }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(rid);

        error.retryable = true;
        reject(error);
      }
    });
  }

  /** Sends a command with retry and, if needed, a reconnect. */
  async send(command, params) {
    this.stats.calls++;

    return withRetry(
      async (attempt) => {
        if (attempt > 1 && (!this.ws || this.ws.closed)) {
          await this.reconnect();
        }

        return this.#sendOnce(command, params);
      },
      {
        attempts: RETRY_ATTEMPTS,
        baseDelayMs: 600,
        label: command,
        onRetry: ({ attempt, attempts, error }) => {
          this.stats.retries++;

          this.logger.warn(
            `${command} failed (${attempt}/${attempts}): ${error.message}`
          );
        },
      }
    );
  }

  async requestSession() {
    const data = await this.#sendOnce("request_session", {
      language: LANGUAGE,
      site_id: SITE_ID,
      source: 42,
    });

    this.sessionId = data?.sid ?? null;

    return data;
  }

  /**
   * A "get" query. Depending on whether it is a subscription, the response
   * arrives in one of two shapes: { subid, data: {...} } or the tree itself.
   */
  async get(what, where) {
    const params = { source: "betting", what, subscribe: false };

    if (where) params.where = where;

    const data = await this.send("get", params);

    return data?.data ?? data ?? {};
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}

/* =========================================================================
 * DATA FETCHING
 * ====================================================================== */

/**
 * Fetches the league tree and match counts of every sport in ONE query.
 *
 * This used to be a separate query per sport. The whole tree is ~56 KB;
 * asking for it once instead of issuing four separate queries means fewer
 * requests and fewer total bytes, and it makes sport discovery free.
 */
async function fetchSportTree(client) {
  const tree = await client.get(
    {
      sport: ["id", "name", "alias"],
      region: ["id", "name"],
      competition: ["id", "name"],
      game: "@count",
    },
    { game: PREMATCH_GAME_FILTER }
  );

  const sports = [];

  for (const sportNode of Object.values(tree?.sport ?? {})) {
    if (sportNode?.id == null) continue;

    const competitions = [];

    for (const region of Object.values(sportNode.region ?? {})) {
      for (const competition of Object.values(region?.competition ?? {})) {
        if (competition?.id == null) continue;

        // No need to query a league that has no matches.
        if (Number(competition.game ?? 0) <= 0) continue;

        competitions.push(competition.id);
      }
    }

    sports.push({
      sportId: sportNode.id,
      name: String(sportNode.name ?? "").trim(),
      alias: String(sportNode.alias ?? "").trim(),
      competitions,
    });
  }

  return sports;
}

/** Fetches the matches for the given league ids. */
async function fetchGamesForCompetitions(client, sportId, competitionIds) {
  const tree = await client.get(
    {
      sport: ["id"],
      region: ["id", "name"],
      competition: ["id", "name"],
      game: [
        "id",
        "team1_name",
        "team2_name",
        "start_ts",
        "show_type",
        "type",
        "is_blocked",
      ],
    },
    {
      sport: { id: sportId },
      competition: { id: { "@in": competitionIds } },
      game: PREMATCH_GAME_FILTER,
    }
  );

  const rows = [];

  for (const sportNode of Object.values(tree?.sport ?? {})) {
    for (const region of Object.values(sportNode?.region ?? {})) {
      for (const competition of Object.values(region?.competition ?? {})) {
        for (const game of Object.values(competition?.game ?? {})) {
          rows.push({
            regionName: String(region?.name ?? "").trim(),
            competitionId: competition?.id,
            competitionName: String(competition?.name ?? "").trim(),
            game,
          });
        }
      }
    }
  }

  return rows;
}

/* =========================================================================
 * MAIN FLOW
 * ====================================================================== */

/**
 * @param {string} siteUrl
 * @param {{ dateFilter?: object, write?: boolean, sports?: string }} [options]
 */
async function virusBetMatchFetcherMain(siteUrl, options = {}) {
  const logger = createLogger(SITE);

  const found = String(siteUrl).match(/virusbettr(\d+)\.com/);

  if (!found) {
    // Old behaviour: an unrecognised URL was skipped silently. The reason
    // is now logged, but the others still are not stopped.
    logger.error(
      `site URL not recognised (expected virusbettr{N}.com): ${siteUrl}`
    );

    return null;
  }

  const number = found[1];

  const wsUrl =
    process.env.VIRUSBET_WS_URL || `wss://eu-swarm-newm.virusbettr${number}.com/`;

  const origin =
    process.env.VIRUSBET_SITE_URL || `https://www.virusbettr${number}.com`;

  const enabledKeys = resolveEnabledSportKeys(options.sports);

  const throttle = createRateLimiter(REQUEST_DELAY_MS);

  const client = new SwarmClient({ wsUrl, origin, logger });

  try {
    return await runFetcher({
      site: SITE,
      logger,
      outputFile: options.outputFile ?? OUTPUT_FILE,
      dateFilter: options.dateFilter,
      write: options.write,

      collect: async ({ output }) => {
        logger.info(`site=${origin} ws=${wsUrl}`);

        await client.connect();

        logger.info(`session opened (sid=${client.sessionId}).`);

        const discovered = await fetchSportTree(client);

        const targets = [];

        const unmapped = [];

        for (const entry of discovered) {
          // The alias ("AmericanFootball") is tried first, then the name
          // ("American Football"); both normalise onto the catalog's alias
          // list.
          const sport = resolveSport(entry.alias, entry.name);

          if (!sport) {
            if (entry.competitions.length) unmapped.push(entry.name || entry.alias);
            continue;
          }

          if (enabledKeys && !enabledKeys.has(sport.key)) continue;

          if (!entry.competitions.length) continue;

          targets.push({ ...entry, sportKey: sport.key });
        }

        if (unmapped.length) {
          logger.debug(`skipped sports missing from the catalog: ${unmapped.join(", ")}`);
        }

        // The league groups of all sports share one work queue, so small
        // sports do not leave the workers idle.
        const tasks = [];

        for (const target of targets) {
          for (const ids of chunkArray(target.competitions, CHUNK_SIZE)) {
            tasks.push({ sportKey: target.sportKey, sportId: target.sportId, ids });
          }
        }

        logger.info(
          `discovered ${discovered.length} sports, ${targets.length} targeted, ` +
            `${tasks.length} league groups (concurrency: ${CONCURRENCY})`
        );

        const results = await mapWithConcurrency(
          tasks,
          CONCURRENCY,
          async (task) => {
            await throttle();

            return {
              task,
              rows: await fetchGamesForCompetitions(
                client,
                task.sportId,
                task.ids
              ),
            };
          }
        );

        let failed = 0;

        for (const result of results) {
          if (result.status === "rejected") {
            failed++;

            logger.warn(`could not fetch league group: ${result.reason.message}`);

            continue;
          }

          const { task, rows } = result.value;

          for (const row of rows) {
            const game = row.game;

            // "OUTRIGHT" records (who wins the title and so on) are not matches.
            if (game?.show_type === "OUTRIGHT") continue;

            const { date, time } = formatEpochSeconds(
              game?.start_ts,
              DEFAULT_TIMEZONE
            );

            output.add(task.sportKey, {
              eventId: game?.id,
              leagueId: row.competitionId,
              leagueName: row.competitionName,
              countryName: row.regionName,
              home: game?.team1_name,
              away: game?.team2_name,
              date,
              time,
            });
          }
        }

        if (failed) {
          logger.warn(`${failed} of ${tasks.length} groups could not be fetched.`);
        }

        logger.info(
          `${client.stats.calls} queries, ${client.stats.retries} retries, ` +
            `${client.stats.reconnects} reconnects`
        );
      },
    });
  } finally {
    client.close();
  }
}

export { virusBetMatchFetcherMain, SwarmClient, PREMATCH_GAME_FILTER };
