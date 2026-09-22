/**
 * VIRUSBET MAC CEKICI
 *
 * Cikti:  virus_bet-matches.json  (betist ile birebir ayni yapi)
 *
 * ---------------------------------------------------------------------------
 * PROTOKOL
 *
 * Virusbet, BetConstruct "swarm" altyapisini kullaniyor. Veri duz HTTP ile
 * degil, tek bir WebSocket uzerinden JSON komutlariyla geliyor:
 *
 *   wss://eu-swarm-newm.virusbettr{N}.com/   (Origin: https://www.virusbettr{N}.com)
 *
 *   1. {"command":"request_session","params":{...}}   (giris GEREKMIYOR)
 *   2. {"command":"get","params":{"source":"betting","what":{...},"where":{...}}}
 *      -> data.data.sport[id].region[id].competition[id].game[id]
 *
 * ---------------------------------------------------------------------------
 * ESKI SURUME GORE NE DEGISTI
 *
 *   - Spor listesi SABIT DEGIL. Eskiden dort sport_id koda gomuluydu; swarm
 *     zaten tum spor agacini veriyor. Artik tek sorguyla 50+ spor kesfediliyor
 *     ve katalogla eslestiriliyor.
 *   - Lig listesi icin SPOR BASINA ayri sorgu atiliyordu (N istek). Artik
 *     TEK sorgu tum sporlarin lig agacini + mac sayilarini getiriyor (~56 KB).
 *   - Lig gruplari sirayla degil, tek baglanti uzerinde SINIRLI es
 *     zamanlilikla cekiliyor (swarm es zamanli rid destekliyor).
 *   - Baglanti koparsa otomatik yeniden baglanip devam ediliyor; eskiden
 *     bekleyen tum istekler reddedilir ve site tamamen bos donerdi.
 *   - RFC 6455 istemcisi Core/ws.js'e tasindi (mavibet ile ortak).
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

// EC2'de IPv6 rotasi/DNS tercihi WebSocket baglantisini bozabiliyor.
const IP_FAMILY = Number(process.env.VIRUSBET_IP_FAMILY || 4);

const LANGUAGE = "en";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/** Mac oncesi (prematch) gorunen oyunlar. */
const PREMATCH_GAME_FILTER = {
  "@or": [{ visible_in_prematch: 1 }, { type: { "@in": [0, 2] } }],
};

/* =========================================================================
 * SWARM ISTEMCISI
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

    /** Ayni anda yalnizca bir yeniden baglanma denemesi olsun. */
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
      // permessage-deflate KASITLI olarak teklif edilmiyor: swarm sikistirmadan
      // da calisiyor ve boylece cozme katmanina hic girmiyoruz.
      permessageDeflate: false,
      handshakeTimeoutMs: CALL_TIMEOUT_MS,
      logger: this.logger,
    });

    this.ws.onText((text) => {
      let message;

      try {
        message = JSON.parse(text);
      } catch {
        // Bozuk JSON tum akisi durdurmamali.
        return;
      }

      const rid = message?.rid;

      // rid'siz mesajlar abonelik push'lari; kullanmiyoruz.
      if (!rid) return;

      const pending = this.pending.get(rid);

      if (!pending) return;

      this.pending.delete(rid);

      if (message.code !== 0) {
        pending.reject(
          new Error(
            `swarm hata code=${message.code} msg=${JSON.stringify(message.msg ?? message.data ?? "")}`
          )
        );

        return;
      }

      pending.resolve(message.data);
    });

    this.ws.onClose(() => {
      // Bekleyen istekleri "gecici" isaretleyerek reddet ki retry katmani
      // bunlari yeniden denemeye deger gorsun.
      for (const [, pending] of this.pending) {
        const error = new Error("Baglanti kapandi.");
        error.retryable = true;
        pending.reject(error);
      }

      this.pending.clear();
    });

    await this.requestSession();
  }

  /** Kopmus baglantiyi tek seferlik yeniden kurar. */
  async reconnect() {
    if (this.closedByUs) throw new Error("Istemci kapatildi.");

    if (!this.reconnecting) {
      this.reconnecting = (async () => {
        this.stats.reconnects++;

        this.logger.warn("baglanti koptu, yeniden baglaniliyor...");

        try {
          this.ws?.close();
        } catch {
          /* zaten kapali */
        }

        await this.connect();

        this.logger.info("yeniden baglanildi.");
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

        const error = new Error(`"${command}" istegi zaman asimina ugradi.`);
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

  /** Retry + gerekirse yeniden baglanma ile komut gonderir. */
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
            `${command} basarisiz (${attempt}/${attempts}): ${error.message}`
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
   * "get" sorgusu. Yanit abonelik olup olmamasina gore iki sekilde
   * gelebiliyor: { subid, data: {...} } ya da dogrudan agac.
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
 * VERI CEKME
 * ====================================================================== */

/**
 * TEK sorguda tum sporlarin lig agacini ve mac sayilarini getirir.
 *
 * Eskiden bu is spor basina ayri bir sorguydu. Tum agac ~56 KB; dort ayri
 * sorgu atmak yerine bir kere istemek hem daha az istek hem daha az
 * toplam bayt, ve ayrica spor kesfini bedavaya getiriyor.
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

        // Maci olmayan ligi sorgulamaya gerek yok.
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

/** Verilen lig id'leri icin maclari ceker. */
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
 * ANA AKIS
 * ====================================================================== */

/**
 * @param {string} siteUrl
 * @param {{ dateFilter?: object, write?: boolean, sports?: string }} [options]
 */
async function virusBetMatchFetcherMain(siteUrl, options = {}) {
  const logger = createLogger(SITE);

  const found = String(siteUrl).match(/virusbettr(\d+)\.com/);

  if (!found) {
    // Eski davranis: taninmayan URL sessizce atlanirdi. Artik sebebi
    // yaziliyor, ama yine de digerlerini durdurmuyoruz.
    logger.error(
      `site URL'si taninmadi (virusbettr{N}.com bekleniyordu): ${siteUrl}`
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

        logger.info(`oturum acildi (sid=${client.sessionId}).`);

        const discovered = await fetchSportTree(client);

        const targets = [];

        const unmapped = [];

        for (const entry of discovered) {
          // Once alias ("AmericanFootball") sonra ad ("American Football")
          // deneniyor; ikisi de katalogdaki alias listesine normalize olur.
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
          logger.debug(`katalogda olmayan spor atlandi: ${unmapped.join(", ")}`);
        }

        // Tum sporlarin lig gruplari tek is kuyrugunda: kucuk sporlar
        // worker'lari bos birakmasin.
        const tasks = [];

        for (const target of targets) {
          for (const ids of chunkArray(target.competitions, CHUNK_SIZE)) {
            tasks.push({ sportKey: target.sportKey, sportId: target.sportId, ids });
          }
        }

        logger.info(
          `${discovered.length} spor kesfedildi, ${targets.length} hedef, ` +
            `${tasks.length} lig grubu (es zamanli: ${CONCURRENCY})`
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

            logger.warn(`lig grubu alinamadi: ${result.reason.message}`);

            continue;
          }

          const { task, rows } = result.value;

          for (const row of rows) {
            const game = row.game;

            // "OUTRIGHT" kayitlari (sampiyon kim olur vb.) mac degildir.
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
          logger.warn(`${tasks.length} gruptan ${failed} tanesi alinamadi.`);
        }

        logger.info(
          `${client.stats.calls} sorgu, ${client.stats.retries} tekrar, ` +
            `${client.stats.reconnects} yeniden baglanma`
        );
      },
    });
  } finally {
    client.close();
  }
}

export { virusBetMatchFetcherMain, SwarmClient, PREMATCH_GAME_FILTER };
