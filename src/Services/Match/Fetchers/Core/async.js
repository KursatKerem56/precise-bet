/**
 * Ortak asenkron yardimcilari: kontrollu concurrency, retry/backoff ve
 * rate limiting.
 *
 * Uc fetcher da ayni sequential kaliba sahipti:
 *
 *     for (const grup of gruplar) { await istek(grup); await sleep(gecikme); }
 *
 * Bu kalip gecikmeye karsi tamamen savunmasiz: 20 grup x 1 sn RTT = 20 sn,
 * ve bunun tamami beklemeyle geciyor. Burasi ayni isi SINIRLI sayida es
 * zamanli istekle yapmayi sagliyor. "Sinirli" onemli: `Promise.all(hepsi)`
 * demek siteyi dovmek demek, ki bu anti-bot tetikler.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkArray(items, size) {
  const step = Math.max(1, Number(size) || 1);

  const chunks = [];

  for (let i = 0; i < items.length; i += step) {
    chunks.push(items.slice(i, i + step));
  }

  return chunks;
}

/**
 * Sabit sayida worker ile listeyi isler.
 *
 * `Promise.all(items.map(...))` YERINE bu kullaniliyor cunku o, liste ne
 * kadar uzunsa o kadar es zamanli istek acar. Burada ayni anda en fazla
 * `limit` adet is yurur.
 *
 * Bir is patlarsa digerleri DEVAM EDER; sonuc dizisi girdi sirasini korur ve
 * her eleman `{ status, value }` veya `{ status, reason }` doner
 * (Promise.allSettled ile ayni sekil). Boylece kismi basarisizlik cagiran
 * tarafta acikca gorunur, sessizce yutulmaz.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);

  if (items.length === 0) return results;

  const workers = Math.max(1, Math.min(Number(limit) || 1, items.length));

  let cursor = 0;

  const run = async () => {
    for (;;) {
      const index = cursor++;

      if (index >= items.length) return;

      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, run));

  return results;
}

/**
 * Ardisik istekler arasinda en az `minIntervalMs` birakan basit bir kapi.
 *
 * Concurrency ile BIRLIKTE kullaniliyor: concurrency "ayni anda kac istek",
 * bu ise "saniyede kac istek" tarafini tutuyor. Ikisi olmadan es zamanlilik
 * dogrudan rate limit yemeye donusurdu.
 */
function createRateLimiter(minIntervalMs) {
  const interval = Math.max(0, Number(minIntervalMs) || 0);

  let nextSlot = 0;

  return async function acquire() {
    if (interval === 0) return;

    const now = Date.now();

    const slot = Math.max(now, nextSlot);

    nextSlot = slot + interval;

    if (slot > now) await sleep(slot - now);
  };
}

/** Yeniden denemeye deger mi? Varsayilan siniflandirma. */
function isTransientError(error) {
  if (!error) return false;

  // HttpClient/WS katmanlari bunu acikca isaretliyor.
  if (typeof error.retryable === "boolean") return error.retryable;

  const code = error.code;

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "ERR_STREAM_PREMATURE_CLOSE"
  ) {
    return true;
  }

  const status = error.statusCode;

  if (typeof status === "number") {
    return status === 408 || status === 429 || status >= 500;
  }

  // WebSocket protokolleri HTTP durum kodu tasimadigi icin geriye metin
  // kaliyor. "backend_timeout" ve "system is busy" mavibet'in acikca
  // "biraz sonra tekrar dene" dedigi durumlar -- bunlari kalici sayip
  // pahali yedek yola dusmek gereksiz.
  return /timeout|zaman asimi|socket hang up|baglanti kapandi|backend_timeout|system is busy|try again/i.test(
    String(error.message || "")
  );
}

/**
 * Exponential backoff + full jitter ile yeniden deneme.
 *
 * Jitter kasitli: sabit backoff'ta ayni anda patlayan N istek ayni anda
 * yeniden denenir ve ayni duvara tekrar carpar ("thundering herd").
 *
 * Sunucu `Retry-After` verdiyse ona saygi gosteriliyor; rate limit'e karsi
 * dogru davranis tahmin yurutmek degil, sunucunun dedigini beklemektir.
 */
async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 400,
    maxDelayMs = 8000,
    isRetryable = isTransientError,
    onRetry,
    label = "istek",
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= attempts || !isRetryable(error)) throw error;

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));

      const delay =
        typeof error.retryAfterMs === "number" && error.retryAfterMs > 0
          ? Math.min(maxDelayMs, error.retryAfterMs)
          : Math.round(Math.random() * backoff);

      onRetry?.({ attempt, attempts, delay, error, label });

      await sleep(delay);
    }
  }

  throw lastError;
}

export {
  sleep,
  chunkArray,
  mapWithConcurrency,
  createRateLimiter,
  withRetry,
  isTransientError,
};
