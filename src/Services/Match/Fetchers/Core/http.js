/**
 * ORTAK HTTPS ISTEMCISI
 *
 * Eski betist fetcher'i her istegi ciplak `https.get` ile atiyordu. Bunun
 * uc somut maliyeti vardi:
 *
 *   1. Agent verilmedigi icin her istek YENI TLS el sikismasi yapiyordu.
 *      Ayni hosta 23 istek = 23 handshake.
 *   2. HTTP 429 / 403 / 5xx ile 200 arasinda ayrim yoktu; hepsi ayni duz
 *      Error'a doner, yeniden denenmezdi.
 *   3. Yanit boyutu sinirsizdi; beklenmedik dev bir yanit heap'i sisirirdi.
 *
 * Burasi ucunu de cozer ve cookie jar + redirect takibini korur.
 */

import https from "node:https";

import { withRetry } from "./async.js";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  Connection: "keep-alive",
};

class HttpError extends Error {
  constructor(message, { statusCode, retryable, retryAfterMs, body }) {
    super(message);

    this.name = "HttpError";
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

/** "Retry-After" hem saniye hem HTTP-date olabilir; ikisini de kabul et. */
function parseRetryAfter(value) {
  if (!value) return undefined;

  const seconds = Number(value);

  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const when = Date.parse(value);

  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

class HttpClient {
  /**
   * @param {{
   *   headers?: Record<string,string>,
   *   timeoutMs?: number,
   *   maxRedirects?: number,
   *   maxBodyBytes?: number,
   *   maxSockets?: number,
   *   retry?: { attempts?: number, baseDelayMs?: number, maxDelayMs?: number },
   *   rateLimiter?: () => Promise<void>,
   *   logger?: object,
   * }} [options]
   */
  constructor(options = {}) {
    this.baseHeaders = { ...DEFAULT_HEADERS, ...(options.headers ?? {}) };

    this.timeoutMs = options.timeoutMs ?? 25000;

    // Tek bir istegin harcayabilecegi mutlak ust sinir (redirect basina).
    this.hardTimeoutMs = options.hardTimeoutMs ?? this.timeoutMs * 3;

    this.maxRedirects = options.maxRedirects ?? 5;

    // 32 MB. Bu siteler en fazla birkac yuz KB donuyor; bundan buyugu
    // "bir seyler ters gitti" demektir, sessizce yutmak yerine hata verelim.
    this.maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;

    this.retryOptions = {
      attempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      ...(options.retry ?? {}),
    };

    this.rateLimiter = options.rateLimiter ?? null;

    this.logger = options.logger ?? null;

    // Baglantilari yeniden kullanan havuz. Asil kazanc burada.
    this.agent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: options.maxSockets ?? 6,
      maxFreeSockets: 4,
    });

    this.cookieJar = new Map();

    this.stats = { requests: 0, retries: 0, bytes: 0 };
  }

  updateCookies(setCookieHeaders) {
    const list = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : [setCookieHeaders].filter(Boolean);

    for (const line of list) {
      const firstPart = String(line).split(";", 1)[0];

      const eq = firstPart.indexOf("=");

      if (eq <= 0) continue;

      this.cookieJar.set(
        firstPart.slice(0, eq).trim(),
        firstPart.slice(eq + 1).trim()
      );
    }
  }

  cookieHeader() {
    return [...this.cookieJar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  /** Tek deneme; retry sarmalayicisi `get` icinde. */
  #once(url, extraHeaders, redirectCount) {
    return new Promise((resolve, reject) => {
      const cookies = this.cookieHeader();

      const headers = {
        ...this.baseHeaders,
        ...extraHeaders,
        ...(cookies ? { Cookie: cookies } : {}),
      };

      const request = https.get(
        url,
        { headers, agent: this.agent },
        (response) => {
          this.updateCookies(response.headers["set-cookie"] ?? []);

          const status = response.statusCode ?? 0;

          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();

            if (redirectCount >= this.maxRedirects) {
              reject(
                new HttpError("Cok fazla redirect.", {
                  statusCode: status,
                  retryable: false,
                })
              );
              return;
            }

            const nextUrl = new URL(response.headers.location, url).toString();

            this.#once(nextUrl, extraHeaders, redirectCount + 1).then(
              resolve,
              reject
            );

            return;
          }

          const chunks = [];

          let size = 0;

          let aborted = false;

          response.on("data", (chunk) => {
            size += chunk.length;

            // Yanit beklenenden buyukse baglantiyi kes; tamamini bellege
            // almayi beklemek OOM'a giden en kisa yol.
            if (size > this.maxBodyBytes) {
              aborted = true;
              request.destroy();

              reject(
                new HttpError(
                  `Yanit govdesi cok buyuk (>${this.maxBodyBytes} bayt).`,
                  { statusCode: status, retryable: false }
                )
              );

              return;
            }

            chunks.push(chunk);
          });

          response.on("end", () => {
            if (aborted) return;

            const body = Buffer.concat(chunks).toString("utf8");

            this.stats.bytes += size;

            if (status < 200 || status >= 300) {
              // 429 ve 5xx gecici; 4xx (429 haric) kalici. Kalici hatayi
              // yeniden denemek hem bosuna hem de rate limit'i kotulestirir.
              const retryable =
                status === 408 || status === 429 || status >= 500;

              reject(
                new HttpError(
                  `HTTP ${status} ${response.statusMessage ?? ""}`.trim() +
                    `\n${body.slice(0, 300)}`,
                  {
                    statusCode: status,
                    retryable,
                    retryAfterMs: parseRetryAfter(
                      response.headers["retry-after"]
                    ),
                    body,
                  }
                )
              );

              return;
            }

            resolve({ statusCode: status, headers: response.headers, body });
          });

          response.on("error", reject);
        }
      );

      request.on("error", (error) => {
        // Soket seviyesi hatalari neredeyse her zaman gecicidir.
        error.retryable = true;
        reject(error);
      });

      // `setTimeout` yalnizca "hic veri akmiyor" durumunu yakalar.
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(
          new HttpError("Istek zaman asimina ugradi (bosta bekleme).", {
            retryable: true,
          })
        );
      });

      // ...ama saniyede birkac bayt damlatan bir yanit bu kontrolu sonsuza
      // kadar tazeler. Bu yuzden ayrica MUTLAK bir son tarih gerekiyor;
      // aksi halde tek bir yavas istek fetch turunu kilitleyebilir.
      const deadline = setTimeout(() => {
        request.destroy(
          new HttpError(
            `Istek toplam sureyi asti (${this.hardTimeoutMs} ms).`,
            { retryable: true }
          )
        );
      }, this.hardTimeoutMs);

      // Sonuc ne olursa olsun zamanlayici temizlensin, yoksa process
      // gereksiz yere ayakta kalir.
      const clear = () => clearTimeout(deadline);

      request.on("close", clear);
      request.on("error", clear);
    });
  }

  /**
   * GET + otomatik retry/backoff.
   * @returns {Promise<{statusCode:number, headers:object, body:string}>}
   */
  async get(url, extraHeaders = {}) {
    return withRetry(
      async () => {
        if (this.rateLimiter) await this.rateLimiter();

        this.stats.requests++;

        return this.#once(url, extraHeaders, 0);
      },
      {
        ...this.retryOptions,
        label: url,
        onRetry: ({ attempt, attempts, delay, error }) => {
          this.stats.retries++;

          this.logger?.warn(
            `istek basarisiz (${attempt}/${attempts}), ${delay} ms sonra tekrar: ` +
              `${error.message.split("\n")[0]}`
          );
        },
      }
    );
  }

  /** Keep-alive soketlerini birak; process'in asili kalmasini onler. */
  close() {
    this.agent.destroy();
  }
}

export { HttpClient, HttpError, DEFAULT_HEADERS };
