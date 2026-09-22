/**
 * Fetcher'lari saran ortak kabuk.
 *
 * Uc fetcher'in da ana fonksiyonunun SONU birebir ayniydi: sirala, dosyaya
 * yaz, spor basina ozet bas, hic mac yoksa uyar. Burasi o kabuk.
 *
 * Ayrica "kismi basarisizlik" politikasi burada tek yerde tanimli: bir spor
 * patlarsa digerleri yazilmaya devam eder, ama sonuc TAMAMEN bossa mevcut
 * dosyanin uzerine yazilmaz.
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
    // Fetch'in ortasinda patlasak bile o ana kadar toplananlari
    // degerlendirebilmek icin hatayi burada tutup asagida karar veriyoruz.
    failure = error;

    logger.error(`${site} cekimi yarida kesildi: ${error.message}`);
  }

  const data = output.toSorted();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  for (const line of output.summaryLines()) logger.info(line);

  logger.info(
    `toplam ${output.total} mac / ${elapsed} sn` +
      (output.stats.duplicate ? `, ${output.stats.duplicate} tekrar` : "") +
      (output.stats.skipped ? `, ${output.stats.skipped} atlanan` : "") +
      (output.stats.filtered ? `, ${output.stats.filtered} filtrelenen` : "")
  );

  if (output.total === 0) {
    // Onemli: BOS sonucu dosyaya yazmak, calisan son veriyi de yok eder.
    // Gecici bir kesintinin kalici veri kaybina donusmesini engelliyoruz.
    logger.error(
      `hic mac bulunamadi; ${outputFile} DEGISTIRILMEDI ` +
        "(site numarasi degismis veya baglanti engellenmis olabilir)."
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

    logger.info(`JSON yazildi: ${outputFile}`);
  }

  return { data, output, written: write, elapsedMs: Date.now() - startedAt };
}

export { runFetcher };
