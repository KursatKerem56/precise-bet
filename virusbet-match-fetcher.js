/**
 * VIRUSBET MAÇ ÇEKİCİ
 *
 * Kullanım:   node virusbet-match-fetcher.js
 * Çıktı:      virusbet-matches.json
 *
 * Çıktı yapısı betist-match-fetcher.js ile BİREBİR AYNIDIR:
 *
 *   {
 *     "FUTBOL": {
 *       "Türkiye - Süper Lig": {
 *         "2026-09-18": [
 *           { "eventId": "...", "leagueId": "...", "home": "...", "away": "...", "time": "20:00" }
 *         ]
 *       }
 *     },
 *     "BASKETBOL": { ... }, "VOLEYBOL": { ... }, "TENIS": { ... }
 *   }
 *
 * ---------------------------------------------------------------------------
 * PROTOKOL
 *
 * Virusbet, BetConstruct "swarm" altyapısını kullanıyor. Veri normal HTTP
 * ile değil, tek bir WebSocket bağlantısı üzerinden JSON komutlarıyla
 * geliyor (HAR'dan doğrulandı):
 *
 *   wss://eu-swarm-newm.virusbettr1139.com/     (Origin: https://www.virusbettr1139.com)
 *
 * Akış:
 *   1. {"command":"request_session","params":{"language":"tur","site_id":1476,"source":42},"rid":"..."}
 *      -> {"code":0,"rid":"...","data":{"sid":"...", ...}}
 *      Giriş/kimlik doğrulama GEREKMİYOR; bahis verisi herkese açık.
 *
 *   2. {"command":"get","params":{"source":"betting","what":{...},"where":{...}},"rid":"..."}
 *      Yanıt iç içe sözlük ağacı:
 *        data.data.sport[sportId].region[regionId].competition[compId].game[gameId]
 *
 * Bu dosya ayrıca node:tls üzerine yazılmış MİNİMAL bir WebSocket istemcisi
 * (RFC 6455) içeriyor; böylece `ws` paketi kurmaya gerek kalmıyor ve betist
 * dosyası gibi doğrudan `node virusbet-match-fetcher.js` çalıştırılabiliyor.
 *
 * ---------------------------------------------------------------------------
 * VERİ ÇEKME STRATEJİSİ (betist'teki "tüm ligleri dolaş" mantığının karşılığı)
 *
 *   Her spor için:
 *     a) Önce HAFİF bir sorgu ile lig ağacı çekilir (maç sayıları ile):
 *          what  = {sport, region, competition, game:"@count"}
 *          where = {sport:{id}, game:{prematch filtresi}}
 *     b) Lig id'leri CHUNK_SIZE'lık gruplara bölünüp her grup için maçlar
 *        çekilir (tek seferde hepsini istemek çok büyük yanıt üretiyor):
 *          what  = {..., game:[id, team1_name, team2_name, start_ts, ...]}
 *          where = {sport:{id}, competition:{id:{"@in":[...]}}, game:{...}}
 *
 *   "OUTRIGHT" tipi kayıtlar (şampiyon kim olur vb.) maç değildir; iki takım
 *   içermedikleri için atlanır.
 *
 * ---------------------------------------------------------------------------
 * ORTAM DEĞİŞKENLERİ (hepsi isteğe bağlı)
 *
 *   VIRUSBET_NUMBER=1139           Site numarası değişirse sadece bunu değiştirin
 *   VIRUSBET_SITE_ID=1476          Swarm site_id
 *   VIRUSBET_OUTPUT=dosya.json     Çıktı dosyası adı
 *   VIRUSBET_CHUNK_SIZE=20         Tek sorguda kaç lig sorulacak
 *   VIRUSBET_REQUEST_DELAY_MS=120  İstekler arası bekleme
 *   VIRUSBET_DEBUG=1               Gidip gelen komutları ekrana bas
 */

import fs from "node:fs/promises";
import tls from "node:tls";
import crypto from "node:crypto";

/* =========================================================================
 * AYARLAR
 * ====================================================================== */

const VIRUSBET_NUMBER = process.env.VIRUSBET_NUMBER || "1139";

const SITE_URL =
  process.env.VIRUSBET_SITE_URL ||
  `https://www.virusbettr${VIRUSBET_NUMBER}.com`;

const WS_URL =
  process.env.VIRUSBET_WS_URL ||
  `wss://eu-swarm-newm.virusbettr${VIRUSBET_NUMBER}.com/`;

const SITE_ID = Number(process.env.VIRUSBET_SITE_ID || 1476);

const OUTPUT_FILE = process.env.VIRUSBET_OUTPUT || "virusbet-matches.json";

const CHUNK_SIZE = Number(process.env.VIRUSBET_CHUNK_SIZE || 20);

const REQUEST_DELAY_MS = Number(process.env.VIRUSBET_REQUEST_DELAY_MS || 120);

const CALL_TIMEOUT_MS = Number(process.env.VIRUSBET_CALL_TIMEOUT_MS || 30000);

const DEBUG = process.env.VIRUSBET_DEBUG === "1";

const LANGUAGE = "en";

const TIMEZONE = "Europe/Istanbul";

const TARGET_ORDER = ["FUTBOL", "BASKETBOL", "VOLEYBOL", "TENIS"];

// swarm sport id'leri (HAR'dan doğrulandı)
const SPORTS = [
  { name: "FUTBOL", sportId: 1, alias: "Soccer" },
  { name: "BASKETBOL", sportId: 3, alias: "Basketball" },
  { name: "VOLEYBOL", sportId: 5, alias: "Volleyball" },
  { name: "TENIS", sportId: 4, alias: "Tennis" },
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// Maç öncesi (prematch) görünen oyunlar. HAR'daki filtrenin aynısı.
const PREMATCH_GAME_FILTER = {
  "@or": [{ visible_in_prematch: 1 }, { type: { "@in": [0, 2] } }],
};

/* =========================================================================
 * 1) MİNİMAL WEBSOCKET İSTEMCİSİ (RFC 6455) - harici paket gerekmez
 * ====================================================================== */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;

  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  header[0] = 0x80 | opcode; // FIN + opcode

  // İstemciden sunucuya giden çerçeveler MASKELİ olmak zorunda (RFC 6455).
  const mask = crypto.randomBytes(4);

  const masked = Buffer.allocUnsafe(len);

  for (let i = 0; i < len; i++) {
    masked[i] = payload[i] ^ mask[i & 3];
  }

  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(buffer) {
  const frames = [];

  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];

    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;

    let len = b1 & 0x7f;
    let cursor = offset + 2;

    if (len === 126) {
      if (cursor + 2 > buffer.length) break;

      len = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buffer.length) break;

      const big = buffer.readBigUInt64BE(cursor);

      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket çerçevesi çok büyük.");
      }

      len = Number(big);
      cursor += 8;
    }

    let mask = null;

    if (masked) {
      if (cursor + 4 > buffer.length) break;

      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    // Çerçeve henüz tam gelmediyse tamponda bırak.
    if (cursor + len > buffer.length) break;

    let payload = buffer.subarray(cursor, cursor + len);

    if (mask) {
      const unmasked = Buffer.allocUnsafe(len);

      for (let i = 0; i < len; i++) {
        unmasked[i] = payload[i] ^ mask[i & 3];
      }

      payload = unmasked;
    }

    frames.push({ fin, opcode, payload });

    offset = cursor + len;
  }

  return { frames, rest: buffer.subarray(offset) };
}

/**
 * wss:// adresine bağlanır.
 * @returns {Promise<{send(text):void, close():void, onText(cb):void, onClose(cb):void}>}
 */
function wsConnect(url, { origin, userAgent } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const port = parsed.port ? Number(parsed.port) : 443;

    const path = `${parsed.pathname}${parsed.search}` || "/";

    const key = crypto.randomBytes(16).toString("base64");

    const expectedAccept = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");

    const socket = tls.connect(
      {
        host: parsed.hostname,
        port,
        servername: parsed.hostname,
      },
      () => {
        const lines = [
          `GET ${path} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          ...(origin ? [`Origin: ${origin}`] : []),
          ...(userAgent ? [`User-Agent: ${userAgent}`] : []),
          "Accept-Language: tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
          // permessage-deflate KASITLI olarak teklif edilmiyor: sıkıştırılmış
          // çerçeveleri açacak kodumuz yok. Teklif etmezsek sunucu da kullanmaz.
          "",
          "",
        ];

        socket.write(lines.join("\r\n"));
      }
    );

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let fragOpcode = null;
    let fragParts = [];

    const textHandlers = [];
    const closeHandlers = [];

    // El sıkışma yanıtı ile ilk mesajlar AYNI TCP paketinde gelebilir.
    // Dinleyici bağlanana kadar biriktiriyoruz ki mesaj kaybolmasın.
    const pendingTexts = [];

    const emitText = (text) => {
      if (textHandlers.length === 0) {
        pendingTexts.push(text);
        return;
      }

      textHandlers.forEach((cb) => cb(text));
    };

    const api = {
      send(text) {
        if (DEBUG) console.log("  >>", text.slice(0, 200));

        socket.write(encodeFrame(Buffer.from(text, "utf8"), 0x1));
      },

      close() {
        try {
          socket.write(encodeFrame(Buffer.alloc(0), 0x8));
        } catch {
          // soket zaten kapalı olabilir
        }

        socket.end();
        socket.destroy();
      },

      onText(cb) {
        textHandlers.push(cb);

        if (pendingTexts.length) {
          const queued = pendingTexts.splice(0, pendingTexts.length);

          for (const text of queued) cb(text);
        }
      },

      onClose(cb) {
        closeHandlers.push(cb);
      },
    };

    const fail = (error) => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(CALL_TIMEOUT_MS + 10000, () => {
      fail(new Error("WebSocket bağlantı zaman aşımı."));
    });

    socket.on("error", (error) => {
      if (handshakeDone) {
        closeHandlers.forEach((cb) => cb(error));
      } else {
        fail(error);
      }
    });

    socket.on("close", () => {
      closeHandlers.forEach((cb) => cb(null));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // --- Önce HTTP Upgrade yanıtı ---
      if (!handshakeDone) {
        const end = buffer.indexOf("\r\n\r\n");

        if (end === -1) return;

        const head = buffer.subarray(0, end).toString("latin1");

        buffer = buffer.subarray(end + 4);

        if (!/^HTTP\/1\.1 101/i.test(head)) {
          return fail(
            new Error(
              `WebSocket el sıkışması başarısız: ${head.split("\r\n")[0]}`
            )
          );
        }

        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];

        if (accept !== expectedAccept) {
          return fail(new Error("Sec-WebSocket-Accept doğrulaması başarısız."));
        }

        // Sıkıştırma açacak kodumuz yok; sunucu yine de dayatırsa erken uyar.
        if (
          /sec-websocket-extensions:\s*[^\r\n]*permessage-deflate/i.test(head)
        ) {
          return fail(
            new Error(
              "Sunucu permessage-deflate dayattı; bu istemci sıkıştırılmış çerçeveleri çözemiyor."
            )
          );
        }

        handshakeDone = true;

        socket.setTimeout(0);

        resolve(api);
      }

      // --- Sonra çerçeveler ---
      let decoded;

      try {
        decoded = decodeFrames(buffer);
      } catch (error) {
        return closeHandlers.forEach((cb) => cb(error));
      }

      buffer = decoded.rest;

      for (const frame of decoded.frames) {
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa)); // ping -> pong
          continue;
        }

        if (frame.opcode === 0xa) continue; // pong

        if (frame.opcode === 0x8) {
          api.close();
          continue;
        }

        // Metin/ikili çerçeveler parçalı gelebilir.
        if (frame.opcode === 0x0) {
          fragParts.push(frame.payload);
        } else {
          fragOpcode = frame.opcode;
          fragParts = [frame.payload];
        }

        if (frame.fin) {
          const full = Buffer.concat(fragParts);

          fragParts = [];

          if (fragOpcode === 0x1 || fragOpcode === 0x2) {
            const text = full.toString("utf8");

            if (DEBUG) console.log("  <<", text.slice(0, 200));

            emitText(text);
          }

          fragOpcode = null;
        }
      }
    });
  });
}

/* =========================================================================
 * 2) SWARM İSTEMCİSİ
 * ====================================================================== */

class SwarmClient {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.sessionId = null;
  }

  static newRid() {
    return crypto.randomBytes(4).toString("hex");
  }

  async connect() {
    this.ws = await wsConnect(WS_URL, {
      origin: SITE_URL,
      userAgent: USER_AGENT,
    });

    this.ws.onText((text) => {
      let message;

      try {
        message = JSON.parse(text);
      } catch {
        return;
      }

      const rid = message?.rid;

      // rid'i olmayan mesajlar abonelik push'larıdır; kullanmıyoruz.
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
      for (const [, pending] of this.pending) {
        pending.reject(new Error("Bağlantı kapandı."));
      }

      this.pending.clear();
    });
  }

  send(command, params) {
    const rid = SwarmClient.newRid();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`"${command}" isteği zaman aşımına uğradı.`));
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

      this.ws.send(JSON.stringify({ command, params, rid }));
    });
  }

  /** Oturum açar. Giriş gerekmiyor; sadece site/dil bağlamı kuruluyor. */
  async requestSession() {
    const data = await this.send("request_session", {
      language: LANGUAGE,
      site_id: SITE_ID,
      source: 42,
    });

    this.sessionId = data?.sid ?? null;

    return data;
  }

  /**
   * "get" sorgusu atar ve veri ağacını döndürür.
   * Yanıt, abonelik olup olmamasına göre iki şekilde gelebiliyor:
   *   { subid, data: {...} }   ya da   { ...ağaç... }
   * İkisini de destekliyoruz.
   */
  async get(what, where, { subscribe = false } = {}) {
    const params = { source: "betting", what, subscribe };

    if (where) params.where = where;

    const data = await this.send("get", params);

    return data?.data ?? data ?? {};
  }

  close() {
    this.ws?.close();
  }
}

/* =========================================================================
 * 3) TARİH / SAAT
 * ====================================================================== */

const dateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** start_ts (unix SANİYE) -> { date: "2026-09-18", time: "20:00" } Türkiye saati */
function formatStartTs(startTs) {
  const date = new Date(Number(startTs) * 1000);

  if (Number.isNaN(date.getTime())) {
    return { date: "UNKNOWN_DATE", time: "" };
  }

  const parts = dateTimeFormatter.formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkArray(items, size) {
  const chunks = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

/* =========================================================================
 * 4) VERİ ÇEKME
 * ====================================================================== */

/** Ağaçtaki (sport -> region -> competition -> game) tüm oyunları düzleştirir. */
function flattenGames(tree) {
  const rows = [];

  const sports = tree?.sport ?? {};

  for (const sport of Object.values(sports)) {
    const regions = sport?.region ?? {};

    for (const region of Object.values(regions)) {
      const competitions = region?.competition ?? {};

      for (const competition of Object.values(competitions)) {
        const games = competition?.game ?? {};

        for (const game of Object.values(games)) {
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

/** Bir sporun lig listesini (hafif sorgu) çeker. */
async function fetchCompetitions(client, sport) {
  const tree = await client.get(
    {
      sport: ["id", "name", "alias"],
      region: ["id", "name", "alias"],
      competition: ["id", "name"],
      game: "@count",
    },
    {
      sport: { id: sport.sportId },
      game: PREMATCH_GAME_FILTER,
    }
  );

  const competitions = [];

  const sports = tree?.sport ?? {};

  for (const sportNode of Object.values(sports)) {
    for (const region of Object.values(sportNode?.region ?? {})) {
      for (const competition of Object.values(region?.competition ?? {})) {
        if (competition?.id == null) continue;

        competitions.push({
          id: competition.id,
          name: String(competition.name ?? "").trim(),
          regionName: String(region?.name ?? "").trim(),
          gameCount: Number(competition.game ?? 0),
        });
      }
    }
  }

  return competitions;
}

/** Verilen lig id'leri için maçları çeker. */
async function fetchGamesForCompetitions(client, sport, competitionIds) {
  const tree = await client.get(
    {
      sport: ["id", "name", "alias"],
      region: ["id", "name", "alias"],
      competition: ["id", "name"],
      game: [
        "id",
        "team1_name",
        "team2_name",
        "start_ts",
        "show_type",
        "type",
        "sport_alias",
        "is_blocked",
      ],
    },
    {
      sport: { id: sport.sportId },
      competition: { id: { "@in": competitionIds } },
      game: PREMATCH_GAME_FILTER,
    }
  );

  return flattenGames(tree);
}

/** Bir sporun tüm maçlarını toplar. */
async function fetchSportMatches(client, sport) {
  let competitions = [];

  try {
    competitions = await fetchCompetitions(client, sport);
  } catch (error) {
    console.error(`${sport.name}: lig listesi alınamadı - ${error.message}`);
    return [];
  }

  // Maçı olmayan ligi sorgulamaya gerek yok.
  const withGames = competitions.filter((c) => c.gameCount > 0);

  console.log(
    `${sport.name}: sportId=${sport.sportId}, lig=${competitions.length} (maçı olan: ${withGames.length})`
  );

  const groups = chunkArray(
    withGames.map((c) => c.id),
    CHUNK_SIZE
  );

  const rows = new Map(); // gameId -> satır

  for (let i = 0; i < groups.length; i++) {
    console.log(`  grup ${i + 1}/${groups.length} -> ${groups[i].length} lig`);

    try {
      for (const row of await fetchGamesForCompetitions(
        client,
        sport,
        groups[i]
      )) {
        if (row.game?.id != null) rows.set(String(row.game.id), row);
      }
    } catch (error) {
      console.error(`  grup ${i + 1} alınamadı: ${error.message}`);
    }

    if (REQUEST_DELAY_MS > 0 && i + 1 < groups.length) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log(`  benzersiz maç: ${rows.size}`);

  return [...rows.values()];
}

/* =========================================================================
 * 5) ÇIKTI (betist-match-fetcher.js ile aynı yapı)
 * ====================================================================== */

function addRowsToOutput(output, sportName, rows) {
  let skipped = 0;

  for (const row of rows) {
    const game = row.game;

    // "OUTRIGHT" kayıtları (şampiyon kim olur, kupayı kim kazanır vb.)
    // maç değildir: tek taraf içerirler.
    if (game?.show_type === "OUTRIGHT" || !game?.team2_name) {
      skipped++;
      continue;
    }

    const leagueName = String(
      row.competitionName || `LIG_${row.competitionId}`
    ).trim();

    const countryName = String(row.regionName || "").trim();

    const leagueKey = countryName
      ? `${countryName} - ${leagueName}`
      : leagueName;

    const { date, time } = formatStartTs(game.start_ts);

    output[sportName][leagueKey] ??= {};

    output[sportName][leagueKey][date] ??= [];

    output[sportName][leagueKey][date].push({
      eventId: String(game.id),

      leagueId: row.competitionId != null ? String(row.competitionId) : "",

      home: String(game.team1_name ?? "").trim(),

      away: String(game.team2_name ?? "").trim(),

      time,
    });
  }

  if (skipped > 0) {
    console.log(`  (${skipped} outright/tek taraflı kayıt atlandı)`);
  }
}

function sortOutput(output) {
  const sorted = {};

  for (const sport of TARGET_ORDER) {
    sorted[sport] = {};

    const leagueEntries = Object.entries(output[sport] || {}).sort(([a], [b]) =>
      a.localeCompare(b, "tr")
    );

    for (const [league, dates] of leagueEntries) {
      sorted[sport][league] = {};

      for (const date of Object.keys(dates).sort()) {
        sorted[sport][league][date] = dates[date].sort((a, b) => {
          const byTime = String(a.time).localeCompare(String(b.time));

          if (byTime !== 0) {
            return byTime;
          }

          return `${a.home}-${a.away}`.localeCompare(
            `${b.home}-${b.away}`,
            "tr"
          );
        });
      }
    }
  }

  return sorted;
}

/* =========================================================================
 * 6) ANA AKIŞ
 * ====================================================================== */

async function main() {
  console.log(`Virusbet: ${SITE_URL}`);

  console.log(`Swarm WS: ${WS_URL}`);

  console.log("Bağlanılıyor...");

  const client = new SwarmClient();

  await client.connect();

  const session = await client.requestSession();

  console.log(
    `Oturum açıldı (sid=${client.sessionId}, sürüm=${session?.version ?? "?"}).\n`
  );

  const output = Object.fromEntries(TARGET_ORDER.map((sport) => [sport, {}]));

  try {
    for (const sport of SPORTS) {
      try {
        const rows = await fetchSportMatches(client, sport);

        addRowsToOutput(output, sport.name, rows);
      } catch (error) {
        console.error(`${sport.name} çekilirken hata: ${error.message}`);
      }
    }
  } finally {
    client.close();
  }

  const finalOutput = sortOutput(output);

  await fs.writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(finalOutput, null, 2)}\n`,
    "utf8"
  );

  console.log("");

  console.log(`JSON yazıldı: ${OUTPUT_FILE}`);

  let grandTotal = 0;

  for (const sport of TARGET_ORDER) {
    const leagues = Object.keys(finalOutput[sport]);

    const matchCount = leagues.reduce(
      (sum, league) =>
        sum +
        Object.values(finalOutput[sport][league]).reduce(
          (dateSum, matches) => dateSum + matches.length,
          0
        ),
      0
    );

    grandTotal += matchCount;

    console.log(`${sport}: ${leagues.length} lig / ${matchCount} maç`);
  }

  if (grandTotal === 0) {
    console.log("");
    console.log("UYARI: Hiç maç bulunamadı. Olası sebepler:");
    console.log(
      "  - Site numarası değişmiş olabilir:  VIRUSBET_NUMBER=1140 node virusbet-match-fetcher.js"
    );
    console.log(
      "  - site_id değişmiş olabilir:        VIRUSBET_SITE_ID=... node virusbet-match-fetcher.js"
    );
    console.log(
      "  - Ayrıntılı trafik için:            VIRUSBET_DEBUG=1 node virusbet-match-fetcher.js"
    );

    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);

  process.exitCode = 1;
});
