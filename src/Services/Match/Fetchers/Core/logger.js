/**
 * Fetcher'lar icin ortak loglama.
 *
 * Eskiden her fetcher `console.log("[BETIST]" + mesaj)` yaziyordu: seviye
 * kavrami yoktu, bu yuzden hem uretimde gereksiz gurultu vardi hem de bir
 * sorunu ayiklarken tek care kaynak koda `console.log` eklemekti.
 *
 * Burada tek bir seviye kavrami var ve MATCH_FETCHER_LOG_LEVEL ile
 * ayarlaniyor. Prefix bicimi ("[BETIST] ...") korunuyor ki mevcut log
 * toplama/gruplama aliskanliklari bozulmasin.
 */

const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_LEVEL = "info";

function resolveLevel(value) {
  const key = String(value || "").toLowerCase();

  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? key : null;
}

/**
 * @param {string} prefix Site etiketi, orn. "BETIST"
 * @param {{ level?: string }} [options]
 */
function createLogger(prefix, options = {}) {
  const tag = `[${prefix}]`;

  // Cozumleme sirasi: cagiranin verdigi > site ozel env > genel env > varsayilan.
  const levelName =
    resolveLevel(options.level) ??
    resolveLevel(process.env[`${prefix}_LOG_LEVEL`]) ??
    resolveLevel(process.env.MATCH_FETCHER_LOG_LEVEL) ??
    DEFAULT_LEVEL;

  const threshold = LEVELS[levelName];

  const write = (level, sink, args) => {
    if (LEVELS[level] > threshold) return;

    sink(tag, ...args);
  };

  return {
    level: levelName,

    /** Seviye kontrolu pahali string kurmadan once sorulabilsin diye. */
    isDebug: () => threshold >= LEVELS.debug,

    error: (...args) => write("error", console.error, args),
    warn: (...args) => write("warn", console.warn, args),
    info: (...args) => write("info", console.log, args),
    debug: (...args) => write("debug", console.log, args),
  };
}

export { createLogger, LEVELS };
