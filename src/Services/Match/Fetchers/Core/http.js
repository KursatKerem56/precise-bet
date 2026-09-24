/**
 * SHARED HTTPS CLIENT
 *
 * The old betist fetcher issued every request with a bare `https.get`. That
 * had three concrete costs:
 *
 *   1. With no agent, every request performed a NEW TLS handshake.
 *      23 requests to the same host = 23 handshakes.
 *   2. There was no distinction between HTTP 429 / 403 / 5xx and 200; they
 *      all became the same plain Error and were never retried.
 *   3. The response size was unbounded; an unexpectedly huge response would
 *      blow up the heap.
 *
 * This solves all three while keeping the cookie jar and redirect following.
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

/** "Retry-After" may be seconds or an HTTP-date; accept both. */
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

    // Absolute upper bound a single request may spend (per redirect).
    this.hardTimeoutMs = options.hardTimeoutMs ?? this.timeoutMs * 3;

    this.maxRedirects = options.maxRedirects ?? 5;

    // 32 MB. These sites return a few hundred KB at most; anything larger
    // means "something went wrong", so fail instead of swallowing it.
    this.maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;

    this.retryOptions = {
      attempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      ...(options.retry ?? {}),
    };

    this.rateLimiter = options.rateLimiter ?? null;

    this.logger = options.logger ?? null;

    // The pool that reuses connections. This is where the real win is.
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

  /** A single attempt; the retry wrapper lives in `get`. */
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
                new HttpError("Too many redirects.", {
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

            // If the response is larger than expected, cut the connection;
            // waiting to buffer all of it is the shortest path to OOM.
            if (size > this.maxBodyBytes) {
              aborted = true;
              request.destroy();

              reject(
                new HttpError(
                  `Response body is too large (>${this.maxBodyBytes} bytes).`,
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
              // 429 and 5xx are transient; 4xx (except 429) is permanent.
              // Retrying a permanent error is both useless and makes the
              // rate limiting worse.
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
        // Socket level errors are transient almost every time.
        error.retryable = true;
        reject(error);
      });

      // `setTimeout` only catches the "no data is flowing at all" case.
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(
          new HttpError("Request timed out (idle wait).", {
            retryable: true,
          })
        );
      });

      // ...but a response dripping a few bytes per second refreshes that
      // check forever. So an ABSOLUTE deadline is needed as well; otherwise
      // a single slow request can lock up the whole fetch round.
      const deadline = setTimeout(() => {
        request.destroy(
          new HttpError(
            `Request exceeded its total time budget (${this.hardTimeoutMs} ms).`,
            { retryable: true }
          )
        );
      }, this.hardTimeoutMs);

      // Whatever the outcome, clear the timer, otherwise the process stays
      // alive for no reason.
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
            `request failed (${attempt}/${attempts}), retrying in ${delay} ms: ` +
              `${error.message.split("\n")[0]}`
          );
        },
      }
    );
  }

  /** Release the keep-alive sockets; keeps the process from hanging. */
  close() {
    this.agent.destroy();
  }
}

export { HttpClient, HttpError, DEFAULT_HEADERS };
