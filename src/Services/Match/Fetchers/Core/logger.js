/**
 * Shared logging for the fetchers.
 *
 * Previously every fetcher wrote `console.log("[BETIST]" + message)`: there
 * was no notion of a level, so production was noisy and the only way to
 * debug an issue was to add another `console.log` to the source.
 *
 * Here there is a single level concept, configured through
 * MATCH_FETCHER_LOG_LEVEL. The prefix format ("[BETIST] ...") is preserved so
 * existing log collection/grouping habits keep working.
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
 * @param {string} prefix Site label, e.g. "BETIST"
 * @param {{ level?: string }} [options]
 */
function createLogger(prefix, options = {}) {
  const tag = `[${prefix}]`;

  // Resolution order: caller supplied > site specific env > global env > default.
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

    /** So the level can be checked before building an expensive string. */
    isDebug: () => threshold >= LEVELS.debug,

    error: (...args) => write("error", console.error, args),
    warn: (...args) => write("warn", console.warn, args),
    info: (...args) => write("info", console.log, args),
    debug: (...args) => write("debug", console.log, args),
  };
}

export { createLogger, LEVELS };
