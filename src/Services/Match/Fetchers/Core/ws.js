/**
 * ORTAK MINIMAL WEBSOCKET ISTEMCISI (RFC 6455)
 *
 * mavibet ve virusbet fetcher'lari bu kodun neredeyse birebir ayni iki
 * kopyasini tasiyordu (~250 satir x 2). Tek fark mavibet'in ayrica
 * permessage-deflate (RFC 7692) cozmesiydi.
 *
 * Ikisi burada birlestirildi: deflate destegi opsiyonel bir bayrak.
 * `ws` paketi bilerek kullanilmiyor -- ikisi de zaten node:tls uzerine
 * yazilmisti ve bu dosyalar bagimsiz calisabilsin diye tasarlanmisti;
 * davranisi korumak icin ayni yol surduruluyor.
 */

import tls from "node:tls";
import crypto from "node:crypto";
import zlib from "node:zlib";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/**
 * permessage-deflate cozucu.
 *
 * Sunucu "server_no_context_takeover" BILDIRMEDIYSE tek bir deflate akisini
 * tum mesajlar boyunca surdurur. O durumda mesajlar ayri ayri acilamaz;
 * kalici bir inflate akisini SIRAYLA beslemek zorunludur. Sira bozulursa
 * tum sonraki mesajlar coder.
 */
class PermessageDeflate {
  constructor(noContextTakeover) {
    this.noContextTakeover = noContextTakeover;
    this.stream = null;
    this.chunks = [];
    this.lastError = null;
    this.queue = Promise.resolve();
  }

  #ensureStream() {
    if (this.stream) return;

    this.stream = zlib.createInflateRaw({ windowBits: 15 });
    this.stream.on("data", (chunk) => this.chunks.push(chunk));
    this.stream.on("error", (error) => {
      this.lastError = error;
    });
  }

  inflate(payload) {
    const task = this.queue.then(
      () =>
        new Promise((resolve, reject) => {
          if (this.noContextTakeover && this.stream) {
            this.stream.close();
            this.stream = null;
          }

          this.#ensureStream();

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

    // Hata olsa bile kuyruk ilerlesin, yoksa baglanti kilitlenir.
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
      /* zaten kapali olabilir */
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

  // Istemciden sunucuya giden cerceveler MASKELI olmak zorunda (RFC 6455).
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
    // RSV1 = "bu mesaj sikistirildi"; yalnizca ilk cercevede set edilir.
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
        throw new Error("WebSocket cercevesi cok buyuk.");
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

    // Cerceve henuz tam gelmediyse tamponda birak.
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
 * wss:// adresine baglanir.
 *
 * @param {string} url
 * @param {{
 *   origin?: string,
 *   userAgent?: string,
 *   subprotocol?: string,
 *   permessageDeflate?: boolean,
 *   family?: number,
 *   handshakeTimeoutMs?: number,
 *   extraHeaders?: string[],
 *   logger?: object,
 * }} [options]
 * @returns {Promise<{send(text:string):void, close():void, onText(cb):void, onClose(cb):void}>}
 */
function connectWebSocket(url, options = {}) {
  const {
    origin,
    userAgent,
    subprotocol,
    permessageDeflate = false,
    family,
    handshakeTimeoutMs = 30000,
    extraHeaders = [],
    logger = null,
  } = options;

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
        // EC2'de IPv6 rotasi/DNS tercihi WS baglantisini bozabiliyor;
        // cagiran taraf IPv4'e sabitleyebilsin diye acik birakildi.
        ...(family ? { family } : {}),
      },
      () => {
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: ${parsed.host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            ...(subprotocol
              ? [`Sec-WebSocket-Protocol: ${subprotocol}`]
              : []),
            ...(origin ? [`Origin: ${origin}`] : []),
            ...(userAgent ? [`User-Agent: ${userAgent}`] : []),
            "Accept-Language: tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
            // Deflate teklif EDILMEZSE sunucu da kullanmaz; cozucusu
            // olmayan cagiranlar icin bu en guvenli varsayilan.
            ...(permessageDeflate
              ? [
                  "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits",
                ]
              : []),
            ...extraHeaders,
            "",
            "",
          ].join("\r\n")
        );
      }
    );

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let fragOpcode = null;
    let fragParts = [];
    let fragCompressed = false;
    let inflater = null;

    // Sikistirma acma asenkron; mesaj SIRASI korunmak zorunda.
    let emitQueue = Promise.resolve();

    const textHandlers = [];
    const closeHandlers = [];

    // El sikisma yaniti ile ilk mesajlar AYNI TCP paketinde gelebilir.
    // Dinleyici baglanana kadar biriktiriyoruz ki mesaj kaybolmasin.
    const pendingTexts = [];

    let closed = false;

    const emitText = (text) => {
      if (textHandlers.length === 0) {
        pendingTexts.push(text);
        return;
      }

      for (const cb of textHandlers) cb(text);
    };

    const notifyClose = (error) => {
      if (closed) return;

      closed = true;

      inflater?.close();

      for (const cb of closeHandlers) cb(error ?? null);
    };

    const api = {
      send(text) {
        if (closed) throw new Error("WebSocket kapali.");

        logger?.debug(">>", text.slice(0, 200));

        socket.write(encodeFrame(Buffer.from(text, "utf8"), 0x1));
      },

      close() {
        try {
          socket.write(encodeFrame(Buffer.alloc(0), 0x8));
        } catch {
          // soket zaten kapali olabilir
        }

        socket.end();
        socket.destroy();

        notifyClose(null);
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

      get closed() {
        return closed;
      },
    };

    const fail = (error) => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(handshakeTimeoutMs, () => {
      fail(new Error("WebSocket baglanti zaman asimi."));
    });

    socket.on("error", (error) => {
      if (handshakeDone) notifyClose(error);
      else fail(error);
    });

    socket.on("close", () => notifyClose(null));

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // --- Once HTTP Upgrade yaniti ---
      if (!handshakeDone) {
        const end = buffer.indexOf("\r\n\r\n");

        if (end === -1) return;

        const head = buffer.subarray(0, end).toString("latin1");

        buffer = buffer.subarray(end + 4);

        if (!/^HTTP\/1\.1 101/i.test(head)) {
          return fail(
            new Error(
              `WebSocket el sikismasi basarisiz: ${head.split("\r\n")[0] || "bilinmeyen yanit"}`
            )
          );
        }

        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];

        if (accept !== expectedAccept) {
          return fail(new Error("Sec-WebSocket-Accept dogrulamasi basarisiz."));
        }

        // Alt protokol kabul edilmediyse WAMP mesajlari SESSIZCE yok sayilir
        // ve bos cikti alinir. Erken ve acik hata veriyoruz.
        if (subprotocol) {
          const negotiated = /sec-websocket-protocol:\s*(\S+)/i.exec(head)?.[1];

          if (negotiated !== subprotocol) {
            return fail(
              new Error(
                `Sunucu "${subprotocol}" alt protokolunu kabul etmedi (donen: ${negotiated ?? "yok"}).`
              )
            );
          }
        }

        const extLine =
          /sec-websocket-extensions:\s*([^\r\n]*)/i.exec(head)?.[1] ?? "";

        if (/permessage-deflate/i.test(extLine)) {
          if (!permessageDeflate) {
            // Teklif etmedigimiz halde dayatildiysa cozemeyiz; sessiz
            // bozuk veri yerine acik hata.
            return fail(
              new Error(
                "Sunucu permessage-deflate dayatti; bu istemci sikistirilmis cerceveleri cozemiyor."
              )
            );
          }

          inflater = new PermessageDeflate(
            /server_no_context_takeover/i.test(extLine)
          );

          logger?.debug(`permessage-deflate aktif (${extLine.trim()})`);
        }

        handshakeDone = true;

        socket.setTimeout(0);

        resolve(api);
      }

      // --- Sonra cerceveler ---
      let decoded;

      try {
        decoded = decodeFrames(buffer);
      } catch (error) {
        return notifyClose(error);
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

        // Metin/ikili cerceveler parcali gelebilir.
        if (frame.opcode === 0x0) {
          fragParts.push(frame.payload);
        } else {
          fragOpcode = frame.opcode;
          fragParts = [frame.payload];
          fragCompressed = frame.rsv1;
        }

        if (!frame.fin) continue;

        const full = Buffer.concat(fragParts);
        const compressed = fragCompressed;
        const opcode = fragOpcode;

        fragParts = [];
        fragOpcode = null;
        fragCompressed = false;

        if (opcode !== 0x1 && opcode !== 0x2) continue;

        emitQueue = emitQueue.then(async () => {
          let body = full;

          if (compressed) {
            if (!inflater) {
              logger?.error(
                "sikistirilmis mesaj geldi ama deflate pazarligi yok."
              );
              return;
            }

            try {
              body = await inflater.inflate(full);
            } catch (error) {
              logger?.error(`mesaj acilamadi: ${error.message}`);
              return;
            }
          }

          const text = body.toString("utf8");

          logger?.debug("<<", text.slice(0, 200));

          emitText(text);
        });
      }
    });
  });
}

export { connectWebSocket, encodeFrame, decodeFrames, PermessageDeflate };
