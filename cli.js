#!/usr/bin/env node
/**
 * Komut satırı arayüzü.
 *
 * Kullanım:
 *   node cli.js mavibet1006.har mavibet10062.har
 *   node cli.js *.har -o maclar.json
 *   node cli.js dosya.har --flat            (gruplamadan, düz liste)
 *   node cli.js dosya.har --tz UTC          (farklı saat dilimi)
 *   node cli.js dosya.har --summary         (sadece özet tablo, JSON yok)
 */

import { writeFile } from "node:fs/promises";

import { buildFromHarFiles, DEFAULT_TIMEZONE } from "./har-matches.js";

function parseArgs(argv) {
  const files = [];
  const options = { out: null, flat: false, timeZone: DEFAULT_TIMEZONE, summary: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-o" || arg === "--out") {
      options.out = argv[++i];
    } else if (arg === "--flat") {
      options.flat = true;
    } else if (arg === "--summary") {
      options.summary = true;
    } else if (arg === "--tz") {
      options.timeZone = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      files.push(arg);
    }
  }

  return { files, options };
}

function printHelp() {
  console.log(`
HAR -> maç çıkarıcı (spor -> lig -> tarih)

Kullanım:
  node cli.js <dosya.har> [dosya2.har ...] [seçenekler]

Seçenekler:
  -o, --out <dosya>   Sonucu dosyaya yaz (varsayılan: ekrana bas)
      --flat          Gruplamadan düz maç listesi üret
      --tz <zone>     Saat dilimi (varsayılan: ${DEFAULT_TIMEZONE})
      --summary       JSON yerine kısa özet tablo göster
  -h, --help          Bu yardımı göster
`);
}

function printSummary(result) {
  console.log(`\nSaat dilimi: ${result.timeZone}`);
  console.log("\nKaynak dosyalar:");
  for (const source of result.sources) {
    if (source.ok) {
      console.log(`  ✔ ${source.file}  -> ${source.matchCount} maç  (${source.webSocketMessageCount} ws mesajı)`);
    } else {
      console.log(`  ✖ ${source.file}  -> HATA: ${source.error}`);
    }
  }

  console.log(
    `\nToplam: ${result.totals.matches} maç, ${result.totals.leagues} lig, ${result.totals.sports} spor\n`
  );

  for (const sport of result.sports) {
    console.log(`${sport.sportName}  (${sport.matchCount} maç, ${sport.leagues.length} lig)`);
    for (const league of sport.leagues) {
      const dates = league.dates.map((d) => `${d.date}:${d.matchCount}`).join("  ");
      console.log(`   • ${league.leagueName}  [${league.country ?? "-"}]  ${league.matchCount} maç`);
      console.log(`       ${dates}`);
    }
    console.log("");
  }
}

async function main() {
  const { files, options } = parseArgs(process.argv.slice(2));

  if (options.help || files.length === 0) {
    printHelp();
    process.exit(files.length === 0 && !options.help ? 1 : 0);
  }

  const result = await buildFromHarFiles(files, { timeZone: options.timeZone });

  if (options.summary) {
    printSummary(result);
    return;
  }

  const payload = options.flat
    ? {
        generatedAt: result.generatedAt,
        timeZone: result.timeZone,
        sources: result.sources,
        totals: result.totals,
        matches: result.sports.flatMap((sport) =>
          sport.leagues.flatMap((league) => league.dates.flatMap((date) => date.matches))
        ),
      }
    : result;

  const json = JSON.stringify(payload, null, 2);

  if (options.out) {
    await writeFile(options.out, json, "utf8");
    console.log(`Yazıldı: ${options.out}  (${result.totals.matches} maç)`);
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  console.error("Hata:", error);
  process.exitCode = 1;
});
