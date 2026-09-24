/**
 * The shared shell wrapping the fetchers.
 *
 * The END of all three fetchers' main function was identical: sort, write to
 * file, print a per-sport summary, warn when there are no matches. This is
 * that shell.
 *
 * The "partial failure" policy also lives here, in one place: if one sport
 * blows up the others are still written, but when the result is COMPLETELY
 * empty the existing file is left untouched.
 */

import fs from "node:fs/promises";

import { MatchOutput, createDateFilter } from "./output.js";

/**
 * @param {{
 *   site: string,
 *   logger: object,
 *   outputFile: string,
 *   dateFilter?: object,
 *   write?: boolean,
 *   collect: (ctx: { output: MatchOutput, logger: object }) => Promise<void>,
 * }} params
 */
async function runFetcher({
  site,
  logger,
  outputFile,
  dateFilter,
  write = true,
  collect,
}) {
  const startedAt = Date.now();

  const output = new MatchOutput({
    logger,
    dateFilter: createDateFilter(dateFilter ?? {}),
  });

  let failure = null;

  try {
    await collect({ output, logger });
  } catch (error) {
    // Even if we blow up mid-fetch we still want to use whatever was
    // collected so far, so the error is held here and acted on below.
    failure = error;

    logger.error(`${site} fetch was interrupted: ${error.message}`);
  }

  const data = output.toSorted();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  for (const line of output.summaryLines()) logger.info(line);

  logger.info(
    `total ${output.total} matches / ${elapsed} s` +
      (output.stats.duplicate ? `, ${output.stats.duplicate} duplicate` : "") +
      (output.stats.skipped ? `, ${output.stats.skipped} skipped` : "") +
      (output.stats.filtered ? `, ${output.stats.filtered} filtered` : "")
  );

  if (output.total === 0) {
    // Important: writing an EMPTY result to the file destroys the last
    // working data too. This keeps a temporary outage from turning into
    // permanent data loss.
    logger.error(
      `no matches found; ${outputFile} was NOT MODIFIED ` +
        "(the site number may have changed or the connection may be blocked)."
    );

    if (failure) throw failure;

    return { data, output, written: false, elapsedMs: Date.now() - startedAt };
  }

  if (write) {
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(data, null, 2)}\n`,
      "utf8"
    );

    logger.info(`JSON written: ${outputFile}`);
  }

  return { data, output, written: write, elapsedMs: Date.now() - startedAt };
}

export { runFetcher };
