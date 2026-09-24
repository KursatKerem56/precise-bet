/**
 * Shared async helpers: bounded concurrency, retry/backoff and rate
 * limiting.
 *
 * All three fetchers had the same sequential pattern:
 *
 *     for (const group of groups) { await request(group); await sleep(delay); }
 *
 * That pattern is completely defenceless against latency: 20 groups x 1 s
 * RTT = 20 s, all of it spent waiting. This lets the same work run over a
 * BOUNDED number of concurrent requests. "Bounded" matters: `Promise.all(all)`
 * means hammering the site, which trips anti-bot measures.
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
 * Processes a list with a fixed number of workers.
 *
 * This is used INSTEAD OF `Promise.all(items.map(...))`, which opens as many
 * concurrent requests as the list is long. Here at most `limit` jobs run at
 * the same time.
 *
 * If one job blows up the others CONTINUE; the result array preserves input
 * order and each element is `{ status, value }` or `{ status, reason }` (the
 * same shape as Promise.allSettled). That way partial failure is plainly
 * visible to the caller instead of being swallowed.
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
 * A simple gate that leaves at least `minIntervalMs` between consecutive
 * requests.
 *
 * Used TOGETHER WITH concurrency: concurrency covers "how many requests at
 * once", this covers "how many requests per second". Without both,
 * concurrency would turn straight into getting rate limited.
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

/** Is it worth retrying? The default classification. */
function isTransientError(error) {
  if (!error) return false;

  // The HttpClient/WS layers mark this explicitly.
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

  // WebSocket protocols carry no HTTP status code, so only the text is
  // left. "backend_timeout" and "system is busy" are mavibet explicitly
  // saying "try again shortly" -- treating those as permanent and falling
  // back to the expensive path would be pointless.
  return /timeout|timed out|socket hang up|connection closed|backend_timeout|system is busy|try again/i.test(
    String(error.message || "")
  );
}

/**
 * Retry with exponential backoff + full jitter.
 *
 * The jitter is deliberate: with a fixed backoff, N requests that fail at
 * the same moment retry at the same moment and hit the same wall again (a
 * "thundering herd").
 *
 * If the server sent `Retry-After` it is respected; the right response to a
 * rate limit is to wait as long as the server says, not to guess.
 */
async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 400,
    maxDelayMs = 8000,
    isRetryable = isTransientError,
    onRetry,
    label = "request",
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
