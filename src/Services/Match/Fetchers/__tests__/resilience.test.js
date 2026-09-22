/**
 * Dayaniklilik testleri: retry/backoff, kontrollu concurrency, rate limit.
 *
 * Bunlarin hicbiri ag kullanmiyor; davranis sahte fonksiyonlarla olculuyor.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  withRetry,
  mapWithConcurrency,
  createRateLimiter,
  chunkArray,
  isTransientError,
} from "../Core/async.js";

test("withRetry: gecici hatadan sonra basariyi dondurur", async () => {
  let calls = 0;

  const value = await withRetry(
    async () => {
      calls++;

      if (calls < 3) {
        const error = new Error("gecici");
        error.retryable = true;
        throw error;
      }

      return "tamam";
    },
    { attempts: 5, baseDelayMs: 1 }
  );

  assert.equal(value, "tamam");
  assert.equal(calls, 3);
});

test("withRetry: kalici hatada TEKRAR DENEMEZ", async () => {
  let calls = 0;

  // 404 gibi kalici bir hatayi yeniden denemek hem bosuna hem de
  // rate limit acisindan zararli.
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const error = new Error("HTTP 404");
        error.statusCode = 404;
        throw error;
      },
      { attempts: 5, baseDelayMs: 1 }
    ),
    /404/
  );

  assert.equal(calls, 1);
});

test("withRetry: deneme hakki bitince son hatayi firlatir", async () => {
  let calls = 0;

  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const error = new Error("hep basarisiz");
        error.retryable = true;
        throw error;
      },
      { attempts: 3, baseDelayMs: 1 }
    ),
    /hep basarisiz/
  );

  assert.equal(calls, 3);
});

test("withRetry: Retry-After suresine uyar", async () => {
  const started = Date.now();

  let calls = 0;

  await withRetry(
    async () => {
      calls++;

      if (calls === 1) {
        const error = new Error("HTTP 429");
        error.statusCode = 429;
        error.retryAfterMs = 60;
        throw error;
      }

      return true;
    },
    { attempts: 3, baseDelayMs: 1 }
  );

  assert.ok(Date.now() - started >= 55, "Retry-After beklenmedi");
});

test("isTransientError siniflandirmasi", () => {
  assert.equal(isTransientError({ statusCode: 429 }), true);
  assert.equal(isTransientError({ statusCode: 503 }), true);
  assert.equal(isTransientError({ statusCode: 408 }), true);
  assert.equal(isTransientError({ statusCode: 403 }), false);
  assert.equal(isTransientError({ statusCode: 404 }), false);
  assert.equal(isTransientError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientError(new Error("istek zaman asimina ugradi")), true);
  assert.equal(isTransientError(new Error("bilinmeyen")), false);
  assert.equal(isTransientError(null), false);
});

test("isTransientError: WAMP 'mesgulum' hatalari gecici sayilir", () => {
  // Canli calismada gorulen gercek hata. Bunu kalici saymak, mavibet'i
  // ~1 sn'lik bir tekrar yerine ~100 sn'lik yedek yola dusuruyordu.
  const busy = new Error(
    `WAMP ERROR: wamp.error.backend_timeout | kwargs={"desc":"our system is busy now, please try again a moment later."}`
  );

  assert.equal(isTransientError(busy), true);

  // Ayni topic'i ikinci kez REGISTER etmek KALICI hata; tekrar denenmemeli.
  assert.equal(
    isTransientError(new Error("WAMP ERROR: wamp.error.procedure_already_exists")),
    false
  );
});

test("mapWithConcurrency: es zamanlilik SINIRINI asmiyor", async () => {
  let active = 0;
  let peak = 0;

  await mapWithConcurrency(
    Array.from({ length: 30 }, (_, i) => i),
    4,
    async () => {
      active++;
      peak = Math.max(peak, active);

      await new Promise((r) => setTimeout(r, 5));

      active--;
    }
  );

  assert.ok(peak <= 4, `es zamanlilik sinirini asti: ${peak}`);
  assert.ok(peak > 1, "hic paralellik olmadi");
});

test("mapWithConcurrency: bir is patlarsa digerleri devam eder", async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
    if (n === 2) throw new Error("2 bozuk");

    return n * 10;
  });

  assert.equal(results.length, 4);

  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled", "fulfilled"]
  );

  // Sonuclar GIRDI SIRASINI korur.
  assert.equal(results[0].value, 10);
  assert.equal(results[2].value, 30);
  assert.match(results[1].reason.message, /2 bozuk/);
});

test("mapWithConcurrency: bos liste", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});

test("createRateLimiter: istekler arasinda asgari araligi korur", async () => {
  const acquire = createRateLimiter(20);

  const started = Date.now();

  await Promise.all([acquire(), acquire(), acquire()]);

  // 3 istek x 20 ms -> en az 40 ms (ilki hemen gecer).
  assert.ok(Date.now() - started >= 35, "rate limit uygulanmadi");
});

test("createRateLimiter: 0 aralik beklemez", async () => {
  const acquire = createRateLimiter(0);

  const started = Date.now();

  await Promise.all([acquire(), acquire(), acquire()]);

  assert.ok(Date.now() - started < 20);
});

test("chunkArray", () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkArray([], 3), []);
  // Gecersiz boyut sonsuz donguye yol acmamali.
  assert.deepEqual(chunkArray([1, 2], 0), [[1], [2]]);
});
