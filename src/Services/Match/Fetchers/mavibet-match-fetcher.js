/**
 * MAVIBET MAC CEKICI
 *
 * Cikti:  mavi_bet-matches.json  (betist ile birebir ayni yapi)
 *
 * ---------------------------------------------------------------------------
 * PROTOKOL
 *
 * WebSocket uzerinden WAMP v2 (wamp.2.json alt protokolu), permessage-deflate
 * zorunlu (sunucu buyuk yanitlari yalnizca sikistirilmis gonderiyor).
 *
 *   HELLO -> WELCOME -> (oturum hazirligi) -> REGISTER(topic) + CALL initialDump
 *
 * Sunucu, hazirlik adimlari yapilmadan veri isteklerini "om.rpc.exception"
 * ile reddediyor; primeSession() bu yuzden var, sus degil.
 *
 * ---------------------------------------------------------------------------
 * ESKI SURUME GORE NE DEGISTI -- BU DOSYADAKI EN BUYUK KAZANC
 *
 * Eski akis spor basina soyleydi:
 *     locations/{sportId}                      ->  ~70 ulke
 *       tournaments/{sportId}/{locationId}     ->  ulke basina 1 istek
 *         /sports#tournaments                  ->  LIG BASINA 1 istek
 *         tournament-aggregator-.../{ligId}    ->  LIG BASINA 1-4 istek
 * Futbol icin bu ~560-900 istek ve lig basina 80 ms zorunlu bekleme demekti.
 *
 * Oysa sunucu ayni veriyi TEK topic'te veriyor:
 *     sport-aggregator-main/{sportId}/default-event-info/NOT_LIVE/1
 * -> 1 istek, futbolda 292 lig / 1325 mac (eski yontem 740 mac buluyordu).
 *
 * Sondaki "1" mac basina istenen market sayisi; bize oran lazim olmadigi
 * icin en dusuk deger veriliyor (0 = SINIRSIZ demek, futbolda zaman asimina
 * ugruyor -- bu yuzden 0 DEGIL 1).
 *
 * Eski lig-lig gezme yolu SILINMEDI: toplu topic reddedilirse otomatik ona
 * dusuluyor, boylece sunucu bicim degistirse bile veri gelmeye devam eder.
 *
 * Ayrica spor listesi artik sabit degil: primeSession zaten cektigi (ve
 * eskiden attigi) "disciplinesV2" dokumunden 50 spor kesfediliyor.
 * Tenis'in farkli lig agaci kullandigi da koda gomulu degil; kaydin
 * `showEventCategory` alanindan okunuyor.
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
 * Toplu spor dokumu icin AYRI ve cok daha uzun zaman asimi.
 * Futbol dokumu olculen surede ~17 sn; 20 sn'lik genel sinir bu istegi
 * neredeyse her seferinde kesiyordu.
 */
const BULK_TIMEOUT_MS = Number(process.env.MAVIBET_BULK_TIMEOUT_MS || 120000);

const CONCURRENCY = Number(process.env.MAVIBET_CONCURRENCY || 2);

const REQUEST_DELAY_MS = Number(process.env.MAVIBET_REQUEST_DELAY_MS || 80);

const RETRY_ATTEMPTS = Number(process.env.MAVIBET_RETRY_ATTEMPTS || 3);

/** 0 = sinirsiz. Yalnizca yedek (lig-lig) yolunu sinirlamak icin. */
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
 * WAMP ISTEMCISI
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

    /** Denenen her topic ve sonucu; sorun cikarsa dosyaya yazilir. */
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
      // Sunucu buyuk yanitlari YALNIZCA sikistirilmis gonderiyor.
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
        const error = new Error("Baglanti kapandi.");
        error.retryable = true;
        pending.reject(error);
      }

      this.pending.clear();

      this.welcome?.reject(new Error("WELCOME beklenirken baglanti kapandi."));
      this.welcome = null;
    });

    // WAMP HELLO ucu elemanli olmak ZORUNDA ve "roles" olmadan router
    // oturum acmaz; eksik gonderirsek sonraki mesajlar sessizce yok sayilir.
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

    // WELCOME gelmeden hicbir sey gonderilmiyor; erken istekler router
    // tarafindan sessizce atiliyor (bos ciktinin klasik sebebi).
    const welcomePromise = new Promise((resolve, reject) => {
      this.welcome = { resolve, reject };

      setTimeout(
        () => reject(new Error("WELCOME zaman asimi (sunucu oturum acmadi).")),
        CALL_TIMEOUT_MS
      );
    });

    this.ws.send(JSON.stringify(hello));

    this.sessionId = await welcomePromise;

    this.logger.info(`WAMP oturumu acildi (session ${this.sessionId}).`);
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
          `Sunucu oturumu reddetti (ABORT): ${JSON.stringify(message[2] ?? message[1] ?? "bilinmeyen")}`
        )
      );
      this.welcome = null;
      return;
    }

    if (type === WAMP.INVOCATION) {
      // Sunucu push'u: icerigini kullanmiyoruz ama protokol geregi onayla.
      try {
        this.ws.send(JSON.stringify([WAMP.YIELD, message[1], {}]));
      } catch {
        /* baglanti kapanmis olabilir */
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

      // WAMP ERROR: [8, istekTipi, istekId, details, errorUri, args, kwargs]
      // Sunucunun asil aciklamasi args/kwargs icinde; tek basina errorUri
      // ("om.rpc.exception") hicbir sey anlatmiyor.
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
          `WAMP ERROR: ${message[4] ?? "bilinmeyen"}` +
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

        const error = new Error("Istek zaman asimina ugradi.");
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

        // Yeni oturum yine hazirlik adimlarini gerektiriyor.
        await this.connect();
        await this.primeSession();

        this.logger.info("yeniden baglanildi.");
      })().finally(() => {
        this.reconnecting = null;
      });
    }

    return this.reconnecting;
  }

  /**
   * Bir topic'in anlik dokumu: once REGISTER, sonra initialDump.
   * Hangi adimin koptugu belli olsun diye hatalar etiketleniyor.
   */
  async #dumpOnce(topic, timeoutMs) {
    try {
      await this.register(topic, timeoutMs);
    } catch (error) {
      error.message = `[REGISTER basarisiz] ${error.message}`;
      throw error;
    }

    let data;

    try {
      data = await this.call("/sports#initialDump", { topic }, timeoutMs);
    } catch (error) {
      error.message = `[initialDump basarisiz] ${error.message}`;
      throw error;
    }

    return Array.isArray(data?.records) ? data.records : [];
  }

  /**
   * Retry + yeniden baglanma ile dokum alir.
   *
   * Eski surumde retry HIC YOKTU; mavibet-debug.log'daki "zaman asimi"
   * satirlari o liglerin sessizce kaybolmasi demekti.
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

            // Ayni topic'i ikinci kez REGISTER etmek kalici hata verir;
            // tekrar denemenin anlami yok.
            if (/already|exists|registered/i.test(message)) return false;

            return isTransientError(error);
          },
          onRetry: ({ attempt, attempts: total, error }) => {
            this.stats.retries++;

            this.logger.warn(
              `${label} basarisiz (${attempt}/${total}): ${error.message}`
            );
          },
        }
      );

      this.diagnostics.push({ label, topic, ok: true, records: records.length });

      return records;
    } catch (error) {
      this.diagnostics.push({ label, topic, ok: false, error: error.message });

      this.logger.debug(`${label}: HATA ${error.message}`);

      // Hata firlatmak yerine null: tek bir topic'in patlamasi tum
      // fetch'i durdurmamali.
      return null;
    }
  }

  /**
   * OTURUM HAZIRLAMA -- tarayicinin acilista yaptigi adimlarin aynisi.
   * Atlanirsa sunucu sonraki veri isteklerini reddediyor.
   *
   * DONUS: "disciplinesV2" dokumu. Eskiden bu dokum alinip ATILIYORDU;
   * oysa icinde 50 sporun id'si, adi ve lig agaci tipi var. Spor kesfi
   * artik BEDAVA -- ek istek yok.
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
      this.logger.debug(`[prime] subscribe atlandi: ${error.message}`);
    }

    for (const topic of topics) {
      try {
        await this.register(topic);
      } catch (error) {
        this.logger.debug(`[prime] register atlandi (${topic}): ${error.message}`);
      }
    }

    try {
      await this.call("/sports#getSessionInfo", { lang: LANG });
      await this.call("/sports#configureFonts", {});
    } catch (error) {
      this.logger.debug(`[prime] oturum bilgisi atlandi: ${error.message}`);
    }

    let disciplines = [];

    // Tarayicinin sirasi: disciplinesV2 once.
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
        this.logger.debug(`[prime] dump atlandi (${path}): ${error.message}`);
      }
    }

    this.logger.info("oturum hazirlandi.");

    return disciplines;
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}

const topicFor = (path) => `/sports/${TENANT}/${LANG}/${path}`;

/* =========================================================================
 * SPOR KESFI
 * ====================================================================== */

/**
 * disciplines dokumundeki SPORT kayitlarini katalogla eslestirir.
 *
 * `showEventCategory` sitenin KENDI bildirdigi bayrak: true ise o sporun
 * lig agaci ulke yerine "event category" (WTA, Challenger, ITF...) uzerinden
 * gidiyor. Eskiden bu, tenis icin koda sabit yazilmisti.
 */
function discoverSports(records, enabledKeys, logger) {
  const targets = [];

  const unmapped = [];

  for (const record of records) {
    if (!record || record._type !== "SPORT" || record.id == null) continue;

    // Sanal/simule sporlar gercek mac degil.
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
    logger.debug(`katalogda olmayan spor atlandi: ${unmapped.join(", ")}`);
  }

  // Buyuk sporlar once baslasin: es zamanli worker'lar sonda tek bir dev
  // isi beklemek zorunda kalmasin.
  targets.sort((a, b) => b.upcoming - a.upcoming);

  return targets;
}

/* =========================================================================
 * VERI CEKME
 * ====================================================================== */

/**
 * Bir MATCH kaydini ortak cikti modeline cevirir.
 * @returns {boolean} gercekten eklendiyse true (tekrar/eksik kayit false doner)
 */
function addMatchRecord(output, sportKey, record) {
  const { date, time } = formatEpochMs(record.startTime, DEFAULT_TIMEZONE);

  return output.add(sportKey, {
    eventId: record.id,
    leagueId: record.parentId,
    // Sezonsuz kisa ad varsa tercih et ("Turkiye Super Lig"),
    // yoksa tam ad ("Turkiye Super Lig 2026/2027").
    leagueName: record.shortParentName || record.parentName,
    countryName: record.venueName || record.categoryName,
    home: record.homeParticipantName,
    away: record.awayParticipantName,
    date,
    time,
  });
}

/**
 * TOPLU YOL: bir sporun tum lig ve maclari tek dokumde.
 * @returns {number} eklenen mac sayisi, veya -1 (topic reddedildi)
 */
async function fetchSportBulk(client, sport, output) {
  const records = await client.dump(
    topicFor(
      `sport-aggregator-main/${sport.sportId}/default-event-info/NOT_LIVE/1`
    ),
    {
      label: `${sport.sportKey} toplu`,
      timeoutMs: BULK_TIMEOUT_MS,
      // Sunucu yogunken "backend_timeout" donuyor. Bir-iki backoff'lu
      // tekrar, lig lig gezen yedek yola dusmekten cok daha ucuz
      // (olculen: tekrar ~1 sn, yedek yol ~100 sn).
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
 * YEDEK YOL (eski davranis)
 *
 * Toplu topic reddedilirse lig lig gezilir. Yavas ama calisiyor; sunucu
 * bicim degistirirse tek dayanagimiz bu.
 * ------------------------------------------------------------------------ */

/** Ayni ligin maclarini veren birden fazla topic bicimi var; en hafiften dene. */
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
 * "Yaklasan mac sayisi" alanini guvenli yorumlar.
 * Alan YOKSA 0 saymiyoruz; yalnizca acikca 0 olani atliyoruz.
 */
function hasUpcoming(record) {
  const value = record?.numberOfUpcomingMatches;

  if (value === undefined || value === null || value === "") return true;

  return Number(value) > 0;
}

/** Hangi lig topic bicimi calisiyor -- ilk basarida hatirlanir. */
let workingVariant = null;

async function fetchSportByLeagues(client, sport, output, throttle, logger) {
  const branchTopic = sport.useEventCategory
    ? topicFor(`event-category-by-sport/${sport.sportId}/BOTH`)
    : topicFor(`locations/${sport.sportId}`);

  const branchRecords = await client.dump(branchTopic, {
    label: `${sport.sportKey} dallar`,
  });

  if (!branchRecords) return 0;

  const wantedType = sport.useEventCategory ? "EVENT_CATEGORY" : "LOCATION";

  let branches = branchRecords
    .filter((r) => r?._type === wantedType && r.id != null && hasUpcoming(r))
    .map((r) => ({
      name: r.name ?? `DAL_${r.id}`,
      topic: sport.useEventCategory
        ? topicFor(`tournaments-by-event-category/${r.id}`)
        : topicFor(`tournaments/${sport.sportId}/${r.id}`),
    }));

  if (MAX_LOCATIONS > 0) branches = branches.slice(0, MAX_LOCATIONS);

  logger.info(`${sport.sportKey}: yedek yol, ${branches.length} dal`);

  let added = 0;

  for (const branch of branches) {
    await throttle();

    const records = await client.dump(branch.topic, {
      label: `${sport.sportKey} lig listesi ${branch.name}`,
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
          label: `${sport.sportKey} lig ${tournament.name} [${variant.key}]`,
          attempts: 2,
        });

        if (!matchRecords) continue;

        const matches = matchRecords.filter(
          (r) =>
            r?._type === "MATCH" &&
            r.id != null &&
            String(r.sportId) === sport.sportId
        );

        // Hatasiz ama MAC ICERMEYEN yanit "calisiyor" sayilmaz; yoksa bos
        // donen bir bicimi kalici secip tum ligleri bos toplardik.
        if (!matches.length) continue;

        if (workingVariant !== variant.key) {
          logger.info(`lig verisi icin "${variant.key}" bicimi kullaniliyor`);
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
 * ANA AKIS
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
      `site URL'si taninmadi (mavibet{N}.com bekleniyordu): ${siteUrl}`
    );

    return null;
  }

  const number = found[1];

  // DIKKAT: WebSocket Origin'i ana site degil SPOR alt alan adidir.
  // Yanlis Origin sessizce BOS sonuc verir.
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
            "Spor listesi bos dondu; oturum hazirligi basarisiz olmus olabilir."
          );
        }

        logger.info(
          `${disciplines.length} kayittan ${targets.length} spor hedefleniyor ` +
            `(es zamanli: ${CONCURRENCY})`
        );

        // Es zamanlilik burada 2: bu dokumler cok buyuk (futbol ~22k kayit),
        // daha fazlasi bellek tepe noktasini gereksiz yukseltir.
        const results = await mapWithConcurrency(
          targets,
          CONCURRENCY,
          async (sport) => {
            await throttle();

            const bulk = await fetchSportBulk(client, sport, output);

            if (bulk >= 0) {
              logger.info(`${sport.sportKey}: toplu dokum -> ${bulk} mac`);
              return bulk;
            }

            logger.warn(
              `${sport.sportKey}: toplu dokum reddedildi, lig lig geziliyor.`
            );

            return fetchSportByLeagues(client, sport, output, throttle, logger);
          }
        );

        const failed = results.filter((r) => r.status === "rejected");

        for (const result of failed) {
          logger.error(`spor cekilemedi: ${result.reason.message}`);
        }

        logger.info(
          `${client.stats.calls} dokum, ${client.stats.retries} tekrar, ` +
            `${client.stats.reconnects} yeniden baglanma`
        );

        await writeDiagnostics(client, output, logger);
      },
    });
  } finally {
    client.close();
  }
}

/** Basarisiz topic'leri dosyaya birakir; sessiz basarisizlik olmasin. */
async function writeDiagnostics(client, output, logger) {
  const failed = client.diagnostics.filter((d) => !d.ok);

  if (!failed.length) return;

  const report = [
    `mavibet teshis raporu - ${new Date().toISOString()}`,
    `WS: ${client.wsUrl}`,
    `Origin: ${client.origin}`,
    `denenen: ${client.diagnostics.length}, basarisiz: ${failed.length}, ` +
      `toplanan mac: ${output.total}`,
    "",
    ...failed.map((d) => `HATA  ${d.error}\n      ${d.topic}`),
  ].join("\n");

  try {
    await fs.writeFile(DEBUG_FILE, `${report}\n`, "utf8");

    logger.warn(`${failed.length} istek basarisiz; ayrinti: ${DEBUG_FILE}`);
  } catch (error) {
    logger.warn(`teshis raporu yazilamadi: ${error.message}`);
  }
}

export { mavibetMatchFetcherMain, MavibetClient, discoverSports, topicFor };
