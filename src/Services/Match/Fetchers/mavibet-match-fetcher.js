/**
 * MAVIBET MAÇ ÇEKİCİ
 *
 * Kullanım:   node mavibet-match-fetcher.js
 * Çıktı:      mavibet-matches.json
 *
 * Çıktı yapısı betist-match-fetcher.js ile BİREBİR AYNIDIR:
 *
 *   {
 *     "FUTBOL": {
 *       "Türkiye - Türkiye Süper Lig": {
 *         "2026-09-18": [
 *           { "eventId": "...", "leagueId": "...", "home": "...", "away": "...", "time": "20:00" }
 *         ]
 *       }
 *     },
 *     "BASKETBOL": { ... }, "VOLEYBOL": { ... }, "TENIS": { ... }
 *   }
 *
 * ---------------------------------------------------------------------------
 * NEDEN BU DOSYA BETİST'TEN DAHA UZUN
 *
 * Betist veriyi normal HTTP ile veriyor. Mavibet ise WebSocket üzerinden
 * WAMP v2 protokolü kullanıyor. Bu yüzden bu dosyanın içinde:
 *
 *   1) node:tls üzerine yazılmış MİNİMAL bir WebSocket istemcisi
 *      (RFC 6455 - el sıkışma + çerçeve maskeleme/çözme) bulunuyor.
 *      Böylece `ws` paketini KURMAYA GEREK KALMIYOR; betist dosyası gibi
 *      doğrudan `node mavibet-match-fetcher.js` diyebiliyorsunuz.
 *
 *   2) WAMP katmanı: HELLO -> REGISTER(topic) -> CALL /sports#initialDump
 *      Sunucu push ederse (INVOCATION) protokol gereği YIELD ile yanıtlanıyor.
 *
 * VERİ ÇEKME AKIŞI (betist'teki "tüm ligleri dolaş" mantığının karşılığı)
 *
 *   Her spor için:
 *     a) /sports#marketGroupsOverview  -> o sporun market group id'leri
 *        (topic metninin parçası; sporlara göre değiştiği için sabit
 *         yazmak yerine canlı olarak soruyoruz)
 *     b) topic "locations/{sportId}"   -> ülke listesi (LOCATION kayıtları)
 *     c) topic "tournaments/{sportId}/{locationId}" -> o ülkenin ligleri
 *     d) topic "tournament-aggregator-groups-overview/{tournamentId}/
 *               default-event-info/NOT_LIVE/{marketGroupIds}"
 *        -> o ligin TÜM maçları (adet sınırı yok)
 *
 *   Ek olarak "next-matches-aggregator-groups-overview" de çekilip sonuca
 *   ekleniyor (lig ağacında görünmeyen bazı maçlar buradan yakalanabiliyor).
 *   Aynı maç birden fazla yerden gelirse eventId ile tekilleştiriliyor.
 *
 * ---------------------------------------------------------------------------
 * ORTAM DEĞİŞKENLERİ (hepsi isteğe bağlı)
 *
 *   MAVIBET_NUMBER=1006          Site numarası değişirse sadece bunu değiştirin
 *   MAVIBET_OUTPUT=dosya.json    Çıktı dosyası adı
 *   MAVIBET_MAX_LOCATIONS=10     Hızlı deneme için ülke/kategori sayısını sınırla
 *   MAVIBET_POPULAR_LIMIT=100    "Popüler maçlar" listesi boyutu
 *   MAVIBET_REQUEST_DELAY_MS=80  İstekler arası bekleme
 *   MAVIBET_PROBE=1              TEŞHİS: topic'leri tek tek dene, ne döndüğünü yaz
 *   MAVIBET_DEBUG=1              Gidip gelen tüm WAMP mesajlarını ekrana bas
 */

import fs from "node:fs/promises";
import tls from "node:tls";
import crypto from "node:crypto";
import zlib from "node:zlib";

/* =========================================================================
 * AYARLAR
 * ====================================================================== */

let MAVIBET_NUMBER = process.env.MAVIBET_NUMBER || "1006";

let SITE_URL =
  process.env.MAVIBET_SITE_URL || `https://www.mavibet${MAVIBET_NUMBER}.com`;

// DİKKAT: WebSocket el sıkışmasındaki Origin, ana site değil SPOR alt alan
// adıdır (HAR'da bu şekilde doğrulandı). Yanlış Origin sessiz boş sonuç verir.
let WS_ORIGIN =
  process.env.MAVIBET_WS_ORIGIN ||
  `https://sports2.mavibet${MAVIBET_NUMBER}.com`;

let WS_URL =
  process.env.MAVIBET_WS_URL ||
  `wss://sportsapi.mavibet${MAVIBET_NUMBER}.com/v2`;

// MAVIBET_DEBUG=1 -> gidip gelen tüm WAMP mesajlarını ekrana bas
const DEBUG = process.env.MAVIBET_DEBUG === "1";

const OUTPUT_FILE = process.env.MAVIBET_OUTPUT || "mavi_bet-matches.json";

const TENANT = process.env.MAVIBET_TENANT || "2007";

const LANG = "en";

// Türkiye saati (UTC+3, yaz saati uygulaması yok)
const TIMEZONE = "Europe/Istanbul";

const TARGET_ORDER = ["FUTBOL", "BASKETBOL", "VOLEYBOL", "TENIS"];

// mavibet sportId değerleri ve HER SPORUN KENDİ LİG AĞACI YOLU.
// DİKKAT: Tenis diğerlerinden FARKLI bir hiyerarşi kullanıyor (ülke yerine
// "event category": WTA, Challenger, ITF Men...). HAR'da doğrulandı:
//   futbol/basketbol/voleybol -> locations/{sportId} -> tournaments/{sportId}/{locationId}
//   tenis                     -> event-category-by-sport/3/BOTH -> tournaments-by-event-category/{categoryId}
const SPORTS = [
  { name: "FUTBOL", sportId: 1, tree: "locations" },
  { name: "BASKETBOL", sportId: 8, tree: "locations" },
  { name: "VOLEYBOL", sportId: 20, tree: "locations" },
  { name: "TENIS", sportId: 3, tree: "eventCategory" },
];

const CALL_TIMEOUT_MS = Number(process.env.MAVIBET_CALL_TIMEOUT_MS || 20000);

const REQUEST_DELAY_MS = Number(process.env.MAVIBET_REQUEST_DELAY_MS || 80);

// "popüler maçlar" listesinden kaç maç istenecek.
// NOT: Daha önce "next-matches-aggregator-groups-overview" kullanıyordum ama
// bu topic HAR'da HİÇ GEÇMİYOR (uydurma bir isimdi). Doğrulanmış olan
// "popular-matches-aggregator-groups-overview".
const POPULAR_LIMIT = Number(process.env.MAVIBET_POPULAR_LIMIT || 20);

// 0 = sınırsız. Futbolda 80+ ülke olabiliyor; hepsini dolaşmak zaman alır.
const MAX_LOCATIONS = Number(process.env.MAVIBET_MAX_LOCATIONS || 0);

// Sorun çıkarsa denenen tüm topic'lerin ve hataların yazılacağı dosya.
const DEBUG_FILE = process.env.MAVIBET_DEBUG_FILE || "mavibet-debug.log";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/* =========================================================================
 * 1) MİNİMAL WEBSOCKET İSTEMCİSİ (RFC 6455) - harici paket gerekmez
 * ====================================================================== */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * permessage-deflate (RFC 7692) çözücü.
 *
 * Sunucu yanıtı "permessage-deflate" (ek parametre olmadan) ise sunucu TEK
 * bir deflate akışını tüm mesajlar boyunca sürdürür ("context takeover").
 * Bu durumda her mesajı ayrı ayrı açamayız; kalıcı bir inflate akışı tutup
 * mesajları sırayla beslemek ZORUNDAYIZ. Sıra bozulursa veri çöpe döner.
 *
 * "server_no_context_takeover" varsa her mesaj bağımsızdır; o zaman her
 * mesaj için taze akış kullanmak daha güvenli.
 */
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

class PermessageDeflate {
  constructor(noContextTakeover) {
    this.noContextTakeover = noContextTakeover;
    this.stream = null;
    this.chunks = [];
    // Mesajların SIRAYLA işlenmesi şart (paylaşılan sıkıştırma penceresi).
    this.queue = Promise.resolve();
  }

  _ensureStream() {
    if (this.stream) return;

    this.stream = zlib.createInflateRaw({ windowBits: 15 });
    this.stream.on("data", (chunk) => this.chunks.push(chunk));
    this.stream.on("error", (error) => {
      this.lastError = error;
    });
  }

  /** Sıkıştırılmış mesaj gövdesini açar. */
  inflate(payload) {
    const task = this.queue.then(
      () =>
        new Promise((resolve, reject) => {
          if (this.noContextTakeover && this.stream) {
            this.stream.close();
            this.stream = null;
          }

          this._ensureStream();

          this.chunks = [];
          this.lastError = null;

          this.stream.write(payload);
          this.stream.write(DEFLATE_TAIL);

          this.stream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
            if (this.lastError) {
              reject(this.lastError);
              return;
            }

            resolve(Buffer.concat(this.chunks));
          });
        })
    );

    // Sıradaki mesaj, bu iş bitmeden başlamasın (hata olsa bile).
    this.queue = task.then(
      () => undefined,
      () => undefined
    );

    return task;
  }

  close() {
    try {
      this.stream?.close();
    } catch {
      /* yut */
    }
    this.stream = null;
  }
}

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
    // RSV1: permessage-deflate'te "bu mesaj sıkıştırıldı" demek.
    // Sadece mesajın İLK çerçevesinde set edilir.
    const rsv1 = (b0 & 0x40) !== 0;
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

    frames.push({ fin, rsv1, opcode, payload });

    offset = cursor + len;
  }

  return { frames, rest: buffer.subarray(offset) };
}

/**
 * wss:// adresine bağlanır.
 * @returns {Promise<{send(text):void, close():void, onText(cb):void, onClose(cb):void}>}
 */
function wsConnect(url, { origin, userAgent, subprotocol } = {}) {
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
          // WAMP router'ı hangi serileştirmeyi kullanacağımızı BU header'dan
          // anlıyor. Gönderilmezse sunucu WAMP oturumu açmıyor.
          ...(subprotocol ? [`Sec-WebSocket-Protocol: ${subprotocol}`] : []),
          ...(origin ? [`Origin: ${origin}`] : []),
          ...(userAgent ? [`User-Agent: ${userAgent}`] : []),
          "Accept-Language: tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control: no-cache",
          "Pragma: no-cache",
          // Sunucu büyük yanıtları (lig maç dökümleri ~100-200 KB) YALNIZCA
          // sıkıştırılmış gönderiyor; bu yüzden permessage-deflate şart.
          "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits",
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
    let fragCompressed = false;
    let inflater = null;
    // Sıkıştırma açma asenkron; mesajların SIRASI korunmalı.
    let emitQueue = Promise.resolve();

    const textHandlers = [];
    const closeHandlers = [];

    // El sıkışma yanıtı ile ilk WAMP mesajları AYNI TCP paketinde gelebiliyor.
    // Bu durumda mesajlar, dinleyiciler henüz bağlanmadan işlenip kaybolurdu;
    // dinleyici eklenene kadar burada biriktiriyoruz.
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
        if (DEBUG) console.log("[MAVI_BET]" + "  >>", text.slice(0, 160));
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

        // Dinleyici eklenmeden önce gelmiş mesajları şimdi teslim et.
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

        // Sunucu wamp.2.json alt protokolünü kabul etti mi? Etmediyse WAMP
        // mesajlarımız sessizce yok sayılır ve boş çıktı alırsınız.
        if (subprotocol) {
          const negotiated = /sec-websocket-protocol:\s*(\S+)/i.exec(head)?.[1];

          if (negotiated !== subprotocol) {
            return fail(
              new Error(
                `Sunucu "${subprotocol}" alt protokolünü kabul etmedi (dönen: ${negotiated ?? "yok"}).`
              )
            );
          }
        }

        // permessage-deflate pazarlığı
        const extLine =
          /sec-websocket-extensions:\s*([^\r\n]*)/i.exec(head)?.[1] ?? "";
        if (/permessage-deflate/i.test(extLine)) {
          // "server_no_context_takeover" YOKSA sunucu tek bir deflate akışını
          // mesajlar boyunca sürdürür; bu durumda inflate akışı da kalıcı olmalı.
          inflater = new PermessageDeflate(
            /server_no_context_takeover/i.test(extLine)
          );
          if (DEBUG)
            console.log(
              "[MAVI_BET]" +
                `  [ws] permessage-deflate aktif (${extLine.trim()})`
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
          fragCompressed = frame.rsv1;
        }

        if (frame.fin) {
          const full = Buffer.concat(fragParts);
          const compressed = fragCompressed;
          const opcode = fragOpcode;

          fragParts = [];
          fragOpcode = null;
          fragCompressed = false;

          if (opcode === 0x1 || opcode === 0x2) {
            // Sıra korunmalı: inflate akışı paylaşımlı olduğu için
            // mesajlar geldikleri sırayla açılmak zorunda.
            emitQueue = emitQueue.then(async () => {
              let body = full;

              if (compressed) {
                if (!inflater) {
                  console.error(
                    "[MAVI_BET]" +
                      "[ws] sıkıştırılmış mesaj geldi ama deflate pazarlığı yok."
                  );
                  return;
                }

                try {
                  body = await inflater.inflate(full);
                } catch (error) {
                  console.error(
                    "[MAVI_BET]" + `[ws] mesaj açılamadı: ${error.message}`
                  );
                  return;
                }
              }

              const text = body.toString("utf8");

              if (DEBUG) console.log("[MAVI_BET]" + "  <<", text.slice(0, 160));

              emitText(text);
            });
          }
        }
      }
    });
  });
}

/* =========================================================================
 * 2) WAMP KATMANI
 * ====================================================================== */

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

class MavibetClient {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.clientId = crypto.randomBytes(32).toString("base64");
    this.sessionId = null;
    this.welcomeResolve = null;
    this.welcomeReject = null;
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
    this.ws = await wsConnect(WS_URL, {
      origin: WS_ORIGIN,
      userAgent: USER_AGENT,
      subprotocol: "wamp.2.json",
    });

    this.ws.onText((text) => {
      let message;

      try {
        message = JSON.parse(text);
      } catch {
        return;
      }

      if (!Array.isArray(message)) return;

      this.handle(message);
    });

    this.ws.onClose(() => {
      // Bekleyen istekleri reddet ki program asılı kalmasın.
      for (const [, pending] of this.pending) {
        pending.reject(new Error("Bağlantı kapandı."));
      }

      this.pending.clear();

      if (this.welcomeReject)
        this.welcomeReject(new Error("WELCOME beklenirken bağlantı kapandı."));
    });

    // WAMP HELLO: [1, realm, details] -- ÜÇ elemanlı olmak ZORUNDA.
    // Details içindeki "roles" alanı WAMP spesifikasyonunda zorunlu; eksik
    // gönderilirse router oturumu açmaz ve sonraki mesajlar yok sayılır.
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

    // WELCOME gelmeden hiçbir şey göndermiyoruz; erken gönderilen istekler
    // router tarafından sessizce atılıyor (boş çıktının sebeplerinden biri).
    const welcome = new Promise((resolve, reject) => {
      this.welcomeResolve = resolve;
      this.welcomeReject = reject;

      setTimeout(
        () => reject(new Error("WELCOME zaman aşımı (sunucu oturum açmadı).")),
        CALL_TIMEOUT_MS
      );
    });

    this.ws.send(JSON.stringify(hello));

    this.sessionId = await welcome;

    console.log(
      "[MAVI_BET]" + `WAMP oturumu açıldı (session ${this.sessionId}).\n`
    );
  }

  handle(message) {
    const [type] = message;

    if (type === WAMP.WELCOME) {
      this.welcomeResolve?.(message[1]);
      this.welcomeResolve = null;
      this.welcomeReject = null;
      return;
    }

    if (type === WAMP.ABORT) {
      const reason = message[2] ?? message[1] ?? "bilinmeyen";
      this.welcomeReject?.(
        new Error(`Sunucu oturumu reddetti (ABORT): ${JSON.stringify(reason)}`)
      );
      this.welcomeReject = null;
      this.welcomeResolve = null;
      return;
    }

    if (type === WAMP.INVOCATION) {
      // Sunucu push'u: içeriğini kullanmıyoruz ama protokol gereği onayla.
      this.ws.send(JSON.stringify([WAMP.YIELD, message[1], {}]));
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
      // Sunucunun ASIL açıklaması args/kwargs içinde olur; sadece errorUri
      // ("om.rpc.exception") tek başına hiçbir şey anlatmıyor.
      const errorUri = message[4] ?? "bilinmeyen";
      const details = message[3];
      const args = message[5];
      const kwargs = message[6];

      const extras = [];
      if (details && Object.keys(details).length)
        extras.push(`details=${JSON.stringify(details)}`);
      if (args && args.length) extras.push(`args=${JSON.stringify(args)}`);
      if (kwargs && Object.keys(kwargs).length)
        extras.push(`kwargs=${JSON.stringify(kwargs)}`);

      const suffix = extras.length ? ` | ${extras.join(" ")}` : "";

      pending.reject(new Error(`WAMP ERROR: ${errorUri}${suffix}`));
    }
  }

  request(buildFrame) {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("İstek zaman aşımına uğradı."));
      }, CALL_TIMEOUT_MS);

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

      this.ws.send(JSON.stringify(buildFrame(id)));
    });
  }

  call(procedure, details = {}) {
    return this.request((id) => [
      WAMP.CALL,
      id,
      {},
      procedure,
      [],
      { ...details, ctx: this.ctx() },
    ]);
  }

  register(topic) {
    return this.request((id) => [WAMP.REGISTER, id, {}, topic]);
  }

  subscribe(topic) {
    return this.request((id) => [WAMP.SUBSCRIBE, id, {}, topic]);
  }

  /**
   * OTURUM HAZIRLAMA - tarayıcının açılışta yaptığı adımların aynısı.
   *
   * Bu adımlar atlanırsa sunucu sonraki veri isteklerini "om.rpc.exception"
   * ile reddediyor. Yani süs değil, ZORUNLU: WAMP oturumu açılsa bile
   * uygulama tarafı kendi iç durumunu bu çağrılarla kuruyor.
   * Sıra HAR'dan birebir alındı.
   */
  async primeSession() {
    const disciplineTopics = [
      topicFor("disciplines/LIVE/NOT_VIRTUAL"),
      topicFor("custom-events"),
      topicFor("custom-sports"),
      topicFor("disciplines/BOTH/BOTH"),
      topicFor("disciplinesV2/BOTH/BOTH"),
      topicFor("disciplines/NOT_LIVE/NOT_VIRTUAL"),
    ];

    try {
      await this.subscribe("/registrationDismissed");
    } catch (error) {
      if (DEBUG)
        console.log(
          "[MAVI_BET]" + `  [prime] subscribe atlandı: ${error.message}`
        );
    }

    // Önce hepsini REGISTER et (tarayıcı da böyle yapıyor)
    for (const topic of disciplineTopics) {
      try {
        await this.register(topic);
      } catch (error) {
        if (DEBUG)
          console.log(
            "[MAVI_BET]" +
              `  [prime] register atlandı (${topic}): ${error.message}`
          );
      }
    }

    try {
      await this.call("/sports#getSessionInfo", { lang: LANG });
      await this.call("/sports#configureFonts", {});
    } catch (error) {
      if (DEBUG)
        console.log(
          "[MAVI_BET]" + `  [prime] oturum bilgisi atlandı: ${error.message}`
        );
    }

    // Sonra dökümlerini al (tarayıcının sırası: disciplinesV2 önce)
    const dumpOrder = [
      topicFor("disciplinesV2/BOTH/BOTH"),
      topicFor("disciplines/BOTH/BOTH"),
      topicFor("disciplines/LIVE/NOT_VIRTUAL"),
      topicFor("disciplines/NOT_LIVE/NOT_VIRTUAL"),
      topicFor("custom-sports"),
      topicFor("custom-events"),
    ];

    for (const topic of dumpOrder) {
      try {
        await this.call("/sports#initialDump", { topic });
      } catch (error) {
        if (DEBUG)
          console.log(
            "[MAVI_BET]" + `  [prime] dump atlandı (${topic}): ${error.message}`
          );
      }
    }

    console.log("[MAVI_BET]" + "Oturum hazırlandı.\n");
  }

  /** Bir topic'in anlık dökümü: önce REGISTER, sonra initialDump.
   * Hangi adımın koptuğu belli olsun diye hatalar etiketleniyor. */
  async initialDump(topic) {
    try {
      await this.register(topic);
    } catch (error) {
      throw new Error(`[REGISTER başarısız] ${error.message}`);
    }

    let data;
    try {
      data = await this.call("/sports#initialDump", { topic });
    } catch (error) {
      throw new Error(`[initialDump başarısız] ${error.message}`);
    }

    return Array.isArray(data?.records) ? data.records : [];
  }

  close() {
    this.ws?.close();
  }
}

const topicFor = (path) => `/sports/${TENANT}/${LANG}/${path}`;

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

/** epoch ms -> { date: "2026-09-18", time: "20:00" } (Türkiye saati) */
function formatStartTime(startTime) {
  const date = new Date(Number(startTime));

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

/* =========================================================================
 * 4) VERİ ÇEKME
 * ====================================================================== */

/** O sporun market group id'lerini canlı olarak sorar (topic'in parçası).
 * Tarayıcı LIVE ve NOT_LIVE için ikisini birden çağırıyor; aynısını
 * yapıyoruz çünkü sunucu bunu bir hazırlık adımı olarak bekliyor. */
async function fetchMarketGroupIds(client, sportId) {
  try {
    await client
      .call("/sports#marketGroupsOverview", {
        lang: LANG,
        sportId: String(sportId),
        liveStatus: "LIVE",
      })
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      .catch(() => {});

    const data = await client.call("/sports#marketGroupsOverview", {
      lang: LANG,
      sportId: String(sportId),
      liveStatus: "NOT_LIVE",
    });

    const response = data?.response ?? data?.records ?? [];

    const groups = response
      .filter((x) => x && x._type === "MARKET_GROUP_OVERVIEW" && x.id != null)
      .sort((a, b) => Number(a.position ?? 999) - Number(b.position ?? 999));

    if (DEBUG) {
      console.log(
        "[MAVI_BET]" +
          `  [marketGroups] ham yanıt anahtarları: ${Object.keys(data ?? {}).join(",") || "(boş)"}`
      );
      console.log(
        "[MAVI_BET]" +
          `  [marketGroups] bulunan grup: ${groups.length} -> ${groups.map((g) => g.id).join(",")}`
      );
    }

    if (groups.length) {
      return {
        ids: groups
          .slice(0, 3)
          .map((g) => String(g.id))
          .join(","),
        all: groups.map((g) => String(g.id)),
      };
    }

    // Sessizce varsayılana düşmek, yanlış topic üretip "om.rpc.exception"
    // almamıza yol açıyordu. Artık açıkça uyarıyoruz.
    console.warn(
      "[MAVI_BET]" +
        `  UYARI: sportId=${sportId} için market group listesi BOŞ döndü; varsayılan deneniyor.`
    );
  } catch (error) {
    console.warn(
      "[MAVI_BET]" +
        `  UYARI: market group alınamadı (${error.message}); varsayılan deneniyor.`
    );
  }

  return { ids: "2875,2876,2877", all: ["2875", "2876", "2877"] };
}

/** Tarayıcının bir spor sekmesine girerken yaptığı tarih penceresi çağrısı. */
async function sendSportsDataInfo(client, sportId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const stop = new Date(start);
  stop.setDate(stop.getDate() + 7);

  try {
    await client.call("/sports#sportsDataInfo", {
      lang: LANG,
      sportId: String(sportId),
      epochSecondsStartDate: Math.floor(start.getTime() / 1000),
      epochSecondsStopDate: Math.floor(stop.getTime() / 1000) - 1,
      userTimezoneOffsetInMinutes: 180,
    });
  } catch (error) {
    if (DEBUG)
      console.log(
        "[MAVI_BET]" + `  [hazırlık] sportsDataInfo atlandı: ${error.message}`
      );
  }
}

/** Denenen her topic'i ve sonucunu biriktirir; sorun çıkarsa dosyaya yazılır. */
const diagnostics = [];

function note(entry) {
  diagnostics.push(entry);
  if (DEBUG)
    console.log(
      "[MAVI_BET]" +
        `  [dump] ${entry.label}: ${entry.ok ? entry.records + " kayıt" : "HATA " + entry.error}`
    );
}

/** Bir topic'in dökümünü alır; hata olursa fırlatmak yerine null döner. */
async function tryDump(client, topic, label) {
  try {
    const records = await client.initialDump(topic);
    note({ label, topic, ok: true, records: records.length });
    return records;
  } catch (error) {
    note({ label, topic, ok: false, error: error.message });
    return null;
  }
}

/**
 * Bir "yaklaşan maç sayısı" alanını güvenli yorumlar.
 * Alan YOKSA "0" saymıyoruz (eskiden öyle yapıp her şeyi eliyordum);
 * sadece açıkça 0 olanı atlıyoruz.
 */
function hasUpcoming(record) {
  const value = record?.numberOfUpcomingMatches;
  if (value === undefined || value === null || value === "") return true;
  return Number(value) > 0;
}

/* -------------------------------------------------------------------------
 * TURNUVA TOPIC MERDİVENİ
 *
 * Aynı ligin maçlarını veren BİRDEN FAZLA topic biçimi var (sitenin kendi
 * JS paketinden çıkarıldı). Bunlar payload büyüklüğü ve sunucu tarafındaki
 * gereksinimleri bakımından farklı; hangisinin kabul edileceğini önceden
 * bilemediğimiz için EN HAFİFTEN başlayıp sırayla deniyoruz.
 *
 *   tournament-aggregator-main/{id}/default-event-info/NOT_LIVE/{nrOfMarkets}
 *       -> oran sayısı sınırlı, çok küçük yanıt
 *   tournament-aggregator-groups-overview/{id}/default-event-info/NOT_LIVE/{marketGroups}
 *       -> tam market grubu bilgisiyle, çok büyük yanıt (100-200 KB)
 *
 * İlk çalışan biçim HATIRLANIR; sonraki ligler doğrudan onunla istenir.
 * Böylece hem her ligde boşuna deneme yapılmaz hem de sunucu biçim
 * değiştirirse kod kendini uyarlar.
 * ---------------------------------------------------------------------- */

function tournamentTopicVariants(tournamentId, marketGroups) {
  const single = marketGroups.all[0] ?? "2875";

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
    {
      key: "groups-tek",
      topic: topicFor(
        `tournament-aggregator-groups-overview/${tournamentId}/default-event-info/NOT_LIVE/${single}`
      ),
    },
    {
      key: "groups-uc",
      topic: topicFor(
        `tournament-aggregator-groups-overview/${tournamentId}/default-event-info/NOT_LIVE/${marketGroups.ids}`
      ),
    },
  ];
}

// Hangi biçimin çalıştığı burada tutulur (tüm sporlar için ortak).
let workingTournamentVariant = null;

async function fetchTournamentMatches(
  client,
  tournament,
  marketGroups,
  addRecords
) {
  // Tarayıcı, lig dökümünden önce bu çağrıyı yapıyor; zararsız, taklit ediyoruz.
  try {
    await client.call("/sports#tournaments", {
      lang: LANG,
      tournamentId: String(tournament.id),
    });
  } catch {
    /* zorunlu değil */
  }

  const variants = tournamentTopicVariants(tournament.id, marketGroups);

  // Daha önce maç getirdiği kanıtlanmış biçim varsa önce onu dene.
  const ordered = workingTournamentVariant
    ? [
        ...variants.filter((v) => v.key === workingTournamentVariant),
        ...variants.filter((v) => v.key !== workingTournamentVariant),
      ]
    : variants;

  let answeredWithoutError = false;

  for (const variant of ordered) {
    const records = await tryDump(
      client,
      variant.topic,
      `lig ${tournament.name} [${variant.key}]`
    );

    if (!records) continue; // hata -> sıradaki biçimi dene

    answeredWithoutError = true;

    const matchCount = records.filter((r) => r?._type === "MATCH").length;

    // ÖNEMLİ: Hatasız ama MAÇ İÇERMEYEN yanıt "çalışıyor" sayılmaz.
    // Aksi halde boş dönen bir biçimi kalıcı olarak seçip tüm ligleri
    // boş toplardık. Maç getiren ilk biçimi hatırlıyoruz.
    if (matchCount === 0) continue;

    if (workingTournamentVariant !== variant.key) {
      console.log(
        "[MAVI_BET]" +
          `  (lig verisi için "${variant.key}" biçimi kullanılıyor)`
      );
      workingTournamentVariant = variant.key;
    }

    addRecords(records);
    return true;
  }

  // Hiçbir biçim maç getirmedi. En az biri hatasız yanıt verdiyse bu ligde
  // gerçekten yaklaşan maç yok demektir; hepsi hata verdiyse başarısızlık.
  return answeredWithoutError;
}

/** Bir sporun tüm maçlarını toplar. */
async function fetchSportMatches(client, sport) {
  const matches = new Map(); // eventId -> MATCH kaydı

  const marketGroups = await fetchMarketGroupIds(client, sport.sportId);

  await sendSportsDataInfo(client, sport.sportId);

  console.log(
    "[MAVI_BET]" +
      `${sport.name}: sportId=${sport.sportId}, marketGroups=${marketGroups.ids}`
  );

  const addRecords = (records) => {
    for (const record of records) {
      if (
        record &&
        record._type === "MATCH" &&
        record.id != null &&
        String(record.sportId) === String(sport.sportId)
      ) {
        const key = String(record.id);
        matches.set(key, { ...(matches.get(key) ?? {}), ...record });
      }
    }
  };

  // --- a) ORAN İÇERMEYEN genel liste (en hafif, market grubu gerektirmez) ---
  // Sitenin kendi JS'inde bulunan "no-odds" varyantı. Bize sadece maç adı ve
  // saati lazım olduğu için oranları hiç istememek en sağlamı.
  const noOdds = await tryDump(
    client,
    topicFor(
      `popular-matches-aggregator/${sport.sportId}/${POPULAR_LIMIT}/no-odds`
    ),
    "popüler (oransız)"
  );

  if (noOdds) addRecords(noOdds);

  console.log("[MAVI_BET]" + `  popüler (oransız) -> ${matches.size}`);

  // --- b) Lig ağacı: spora göre iki farklı yol ---
  let branches = [];

  if (sport.tree === "eventCategory") {
    // TENİS: ülke yerine "event category" (WTA, Challenger, ITF...)
    const categories = await tryDump(
      client,
      topicFor(`event-category-by-sport/${sport.sportId}/BOTH`),
      "event kategorileri"
    );

    branches = (categories ?? [])
      .filter(
        (r) =>
          r && r._type === "EVENT_CATEGORY" && r.id != null && hasUpcoming(r)
      )
      .map((r) => ({
        name: r.name ?? `KATEGORI_${r.id}`,
        topic: topicFor(`tournaments-by-event-category/${r.id}`),
      }));
  } else {
    const locations = await tryDump(
      client,
      topicFor(`locations/${sport.sportId}`),
      "ülkeler"
    );

    branches = (locations ?? [])
      .filter(
        (r) => r && r._type === "LOCATION" && r.id != null && hasUpcoming(r)
      )
      .map((r) => ({
        name: r.name ?? `ULKE_${r.id}`,
        topic: topicFor(`tournaments/${sport.sportId}/${r.id}`),
      }));
  }

  if (MAX_LOCATIONS > 0) branches = branches.slice(0, MAX_LOCATIONS);

  console.log(
    "[MAVI_BET]" +
      `  ${sport.tree === "eventCategory" ? "kategori" : "ülke"}: ${branches.length}`
  );

  // --- c) Her daldaki ligler ve o liglerin maçları ---
  let leagueOk = 0;
  let leagueFail = 0;

  for (const [index, branch] of branches.entries()) {
    const records = await tryDump(
      client,
      branch.topic,
      `lig listesi ${branch.name}`
    );

    if (!records) continue;

    const tournaments = records.filter(
      (r) => r && r._type === "TOURNAMENT" && r.id != null && hasUpcoming(r)
    );

    for (const tournament of tournaments) {
      const ok = await fetchTournamentMatches(
        client,
        tournament,
        marketGroups,
        addRecords
      );

      if (ok) leagueOk++;
      else leagueFail++;

      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    }

    console.log(
      "[MAVI_BET]" +
        `  [${index + 1}/${branches.length}] ${branch.name}: ${tournaments.length} lig, toplam maç ${matches.size}`
    );
  }

  console.log(
    "[MAVI_BET]" +
      `  ${sport.name} bitti -> ${leagueOk} lig OK, ${leagueFail} lig başarısız, ${matches.size} maç\n`
  );

  return [...matches.values()];
}

/* =========================================================================
 * 5) ÇIKTI (betist-match-fetcher.js ile aynı yapı)
 * ====================================================================== */

function addMatchesToOutput(output, sportName, records) {
  for (const record of records) {
    // Lig adı: sezonsuz kısa ad varsa onu tercih et ("Türkiye Süper Lig"),
    // yoksa tam ad ("Türkiye Süper Lig 2026/2027").
    const leagueName = String(
      record.shortParentName || record.parentName || `LIG_${record.parentId}`
    ).trim();

    const countryName = String(
      record.venueName || record.categoryName || ""
    ).trim();

    const leagueKey = countryName
      ? `${countryName} - ${leagueName}`
      : leagueName;

    const { date, time } = formatStartTime(record.startTime);

    output[sportName][leagueKey] ??= {};

    output[sportName][leagueKey][date] ??= [];

    output[sportName][leagueKey][date].push({
      eventId: String(record.id),

      leagueId: record.parentId != null ? String(record.parentId) : "",

      home: record.homeParticipantName || "",

      away: record.awayParticipantName || "",

      time,
    });
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
 * TEŞHİS MODU:  MAVIBET_PROBE=1 node mavibet-match-fetcher.js
 * Aday topic'leri tek tek dener ve her birinden ne döndüğünü yazar.
 * Boş sonuç aldığınızda hangi adımın koptuğunu bir bakışta gösterir.
 * ====================================================================== */

async function probe(client) {
  console.log(
    "[MAVI_BET]" + "TEŞHİS MODU - topic biçimleri tek tek deneniyor\n"
  );

  for (const sport of SPORTS) {
    console.log(
      "[MAVI_BET]" + `=== ${sport.name} (sportId=${sport.sportId}) ===`
    );

    const mg = await fetchMarketGroupIds(client, sport.sportId);
    console.log("[MAVI_BET]" + `  market grupları: ${mg.all.join(",")}`);

    await sendSportsDataInfo(client, sport.sportId);

    const light = [
      [
        "popüler (oransız)",
        topicFor(`popular-matches-aggregator/${sport.sportId}/20/no-odds`),
      ],
      ["ülkeler", topicFor(`locations/${sport.sportId}`)],
      [
        "event kategorileri",
        topicFor(`event-category-by-sport/${sport.sportId}/BOTH`),
      ],
    ];

    let sampleTournament = null;

    for (const [label, topic] of light) {
      const records = await tryDump(client, topic, label);

      if (!records) {
        console.log("[MAVI_BET]" + `  ${label.padEnd(20)} HATA`);
        continue;
      }

      const counts = {};
      for (const r of records)
        counts[r?._type ?? "?"] = (counts[r?._type ?? "?"] ?? 0) + 1;
      console.log(
        "[MAVI_BET]" +
          `  ${label.padEnd(20)} OK  ${records.length} kayıt ${JSON.stringify(counts)}`
      );

      if (!sampleTournament) {
        const node = records.find(
          (r) => r?._type === "LOCATION" || r?._type === "EVENT_CATEGORY"
        );

        if (node) {
          const sub =
            node._type === "LOCATION"
              ? topicFor(`tournaments/${sport.sportId}/${node.id}`)
              : topicFor(`tournaments-by-event-category/${node.id}`);

          const tours = await tryDump(client, sub, "örnek lig listesi");
          sampleTournament =
            (tours ?? []).find(
              (x) => x?._type === "TOURNAMENT" && x.id != null
            ) ?? null;
        }
      }
    }

    if (sampleTournament) {
      console.log(
        "[MAVI_BET]" +
          `  örnek lig: ${sampleTournament.name} (${sampleTournament.id})`
      );

      try {
        await client.call("/sports#tournaments", {
          lang: LANG,
          tournamentId: String(sampleTournament.id),
        });
      } catch {
        /* zorunlu değil */
      }

      for (const variant of tournamentTopicVariants(sampleTournament.id, mg)) {
        const records = await tryDump(
          client,
          variant.topic,
          `lig [${variant.key}]`
        );

        if (records) {
          const matchCount = records.filter((r) => r?._type === "MATCH").length;
          console.log(
            "[MAVI_BET]" +
              `  lig [${variant.key.padEnd(11)}] OK  ${records.length} kayıt (MATCH=${matchCount})`
          );
        } else {
          console.log("[MAVI_BET]" + `  lig [${variant.key.padEnd(11)}] HATA`);
        }
      }
    }

    console.log("[MAVI_BET]" + "");
  }
}

/* =========================================================================
 * 6) ANA AKIŞ
 * ====================================================================== */

async function mavibetMatchFetcherMain(siteUrl) {
  const foundSiteNumber = siteUrl.match(/mavibet(\d+)\.com/);

  if (!foundSiteNumber) return;

  MAVIBET_NUMBER = foundSiteNumber[1];

  SITE_URL = `https://www.mavibet${MAVIBET_NUMBER}.com`;

  // DİKKAT: WebSocket el sıkışmasındaki Origin, ana site değil SPOR alt alan
  // adıdır (HAR'da bu şekilde doğrulandı). Yanlış Origin sessiz boş sonuç verir.
  WS_ORIGIN = `https://sports2.mavibet${MAVIBET_NUMBER}.com`;

  WS_URL = `wss://sportsapi.mavibet${MAVIBET_NUMBER}.com/v2`;

  console.log("[MAVI_BET]" + `Mavibet: ${SITE_URL}`);

  console.log("[MAVI_BET]" + `Mavibet WS: ${WS_URL}`);

  console.log("[MAVI_BET]" + "Bağlanılıyor...\n");

  const client = new MavibetClient();

  await client.connect();

  // Sunucu, bu hazırlık adımları yapılmadan veri isteklerini reddediyor.
  await client.primeSession();

  if (process.env.MAVIBET_PROBE === "1") {
    try {
      await probe(client);
    } finally {
      client.close();
    }
    return;
  }

  const output = Object.fromEntries(TARGET_ORDER.map((sport) => [sport, {}]));

  try {
    for (const sport of SPORTS) {
      try {
        const records = await fetchSportMatches(client, sport);

        addMatchesToOutput(output, sport.name, records);
      } catch (error) {
        console.error(
          "[MAVI_BET]" + `${sport.name} çekilirken hata: ${error.message}`
        );
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

  console.log("[MAVI_BET]" + "");
  console.log("[MAVI_BET]" + `JSON yazıldı: ${OUTPUT_FILE}`);

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

    console.log(
      "[MAVI_BET]" + `${sport}: ${leagues.length} lig / ${matchCount} maç`
    );
  }

  // Boş çıktı sessizce geçmesin; ne yapılacağını söyle.
  if (grandTotal === 0) {
    // Sessizce boş JSON bırakmak yerine, ne denendiğini dosyaya yaz.
    const failed = diagnostics.filter((d) => !d.ok);

    const report = [
      `mavibet teşhis raporu - ${new Date().toISOString()}`,
      `WS: ${WS_URL}`,
      `Origin: ${WS_ORIGIN}`,
      `denenen topic sayısı: ${diagnostics.length}, başarısız: ${failed.length}`,
      "",
      ...diagnostics.map((d) =>
        d.ok
          ? `OK    ${d.records.toString().padStart(5)} kayıt  ${d.topic}`
          : `HATA  ${d.error}\n      ${d.topic}`
      ),
    ].join("\n");

    await fs.writeFile(DEBUG_FILE, `${report}\n`, "utf8");

    console.log("[MAVI_BET]" + "");
    console.log("[MAVI_BET]" + "UYARI: Hiç maç bulunamadı.");
    console.log("[MAVI_BET]" + `Ayrıntılı rapor yazıldı: ${DEBUG_FILE}`);
    console.log("[MAVI_BET]" + "Denenecekler:");
    console.log(
      "[MAVI_BET]" +
        "  - Site numarası değişmiş olabilir:  MAVIBET_NUMBER=1007 node mavibet-match-fetcher.js"
    );
    console.log(
      "[MAVI_BET]" +
        "  - Topic biçimlerini tek tek dene:   MAVIBET_PROBE=1 node mavibet-match-fetcher.js"
    );
    console.log(
      "[MAVI_BET]" +
        "  - Tüm trafiği gör:                  MAVIBET_DEBUG=1 node mavibet-match-fetcher.js"
    );

    process.exitCode = 1;
  } else if (diagnostics.some((d) => !d.ok)) {
    // Kısmi başarı: bazı ligler alınamadıysa yine de rapor bırak.
    const failed = diagnostics.filter((d) => !d.ok);
    console.log(
      "[MAVI_BET]" +
        `\n(${failed.length} istek başarısız oldu; ayrıntı için ${DEBUG_FILE})`
    );

    await fs.writeFile(
      DEBUG_FILE,
      failed.map((d) => `HATA ${d.error}\n     ${d.topic}`).join("\n") + "\n",
      "utf8"
    );
  }
}

export { mavibetMatchFetcherMain };
