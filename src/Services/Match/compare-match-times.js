#!/usr/bin/env node
/**
 * MAÇ SAATİ KARŞILAŞTIRICI  (ES6 / ESM, sıfır bağımlılık, Node 18+)
 *
 * Üç sitenin maç listesini karşılaştırır ve AYNI maçın farklı sitelerde
 * FARKLI saatte gösterildiği durumları JSON olarak verir.
 *
 * Girdi, üç fetcher'ın da ürettiği ORTAK yapıdır:
 *
 *   { "FUTBOL": { "Ülke - Lig": { "2026-09-18": [ {eventId,leagueId,home,away,time} ] } }, ... }
 *
 * ---------------------------------------------------------------------------
 * EŞLEŞTİRME HİYERARŞİSİ
 *
 *   SPOR -> LİG -> TARİH -> TAKIM -> SAAT
 *
 * Bu sıra hem doğruluk hem performans için kritik: ucuz ve kesin elemeler
 * önce yapılır, pahalı bulanık karşılaştırma en sona bırakılır.
 *
 *   1) SPOR   : Fetcher'lar zaten katalog anahtarı üretiyor (FUTBOL,
 *               BASKETBOL...). Farklı spor = ASLA eşleşmez; aday indeksinin
 *               en üst seviyesi budur, yani basketbol maçları bir futbol
 *               maçı için hiç taranmaz.
 *
 *   2) LİG    : Kanonik lig id'sine çözülebiliyorsa GÜVENİLİR bir kısıt
 *               olur (farklı id -> doğrudan eleme). Çözülemiyorsa yumuşak
 *               sinyaldir; çünkü üç site lig adlarını çok farklı yazıyor
 *               ("International Clubs - UEFA Champions League" vs
 *               "Europe - UEFA Champions League - League Stage"). Ama
 *               niteleyiciler (Women / U21 / Reserve) her hâlükârda KATI
 *               kısıttır.
 *
 *   3) TARİH  : Aynı gün + (gece yarısını aşanlar için) komşu günler.
 *               Komşu gün adayları yalnızca saat farkı makul bir gece
 *               yarısı kayması kadarsa kabul edilir; aksi halde "aynı
 *               takımların ertesi günkü BAŞKA maçı" yanlışlıkla eşleşirdi.
 *
 *   4) TAKIM  : Asıl belirleyici adım. Birebir -> alias -> kontrollü
 *               bulanık sırasıyla. Niteleyici uyuşmazlığı (B takımı, U19,
 *               kadınlar) isim ne kadar benzerse benzesin eşleşmeyi keser.
 *
 *   5) SAAT   : Tek bir epoch sayısı üzerinden; "23:50 vs 00:10" gerçekte
 *               20 dakikadır, 23 saat 40 dakika değil.
 *
 * Eşleştirme mantığının kendisi ./Matching/ altındaki modüllerde; bu dosya
 * girdiyi okur, eşleştirmeyi sürücüler ve raporu üretir.
 *
 * ---------------------------------------------------------------------------
 * KULLANIM
 *
 *   node compare-match-times.js betist-matches.json maclar.json -o farkli.json
 *   node compare-match-times.js *.json --summary
 *   node compare-match-times.js a.json b.json --tolerans 5      (5 dk'ya kadar farkı yok say)
 *   node compare-match-times.js a.json b.json --eslesmeyenler   (çıktıya eşleşmeyenleri de ekle)
 *   node compare-match-times.js a.json b.json --duz             (gruplamadan düz liste)
 */

import { readFile, writeFile } from "node:fs/promises";

// Spor adi eslemesi burada kopyalanmiyor; fetcher'larla AYNI katalogdan
// geliyor. Eskiden bu dosyadaki SPORT_CANON/SPORT_ORDER listeleri
// fetcher'lardan bagimsizdi ve yeni bir spor eklendiginde burasi
// guncellenmezse o spor "BILINMEYEN" sayilip hic karsilastirilmazdi.
import {
  resolveSport,
  SPORT_ORDER as CATALOG_SPORT_ORDER,
} from "./Fetchers/Sports/catalog.js";

import {
  MATCH_CONFIG,
  buildLeagueIndex,
  buildMatchIndex,
  findMatchCandidates,
  compareMatches,
  resolveLeague,
  normalizeTimestamp,
  UnresolvedCollector,
} from "./Matching/index.js";

// Geriye donuk uyumluluk: bu dosyanin eski genel API'si disari aciliyor.
// src/Services/Match/index.ts `export * from "./compare-match-times"`
// yaptigi icin bu adlarin kaybolmamasi gerekiyor.
export {
  foldText,
  normalizeTeamName,
  normalizeLeagueName,
  similarityRatio,
  teamSimilarity,
  leagueSimilarity,
  toEpochMs,
  compareMatches,
  compareMatchTimes,
  calculateMatchConfidence,
  normalizeTimestamp,
  calculateTimeDifference,
  resolveTeam,
  resolveLeague,
  compareTeams,
  compareLeagues,
  buildMatchIndex,
  findMatchCandidates,
  MATCH_CONFIG,
  MATCH_RESULT,
  CITY_ABBREVIATIONS,
} from "./Matching/index.js";

export { DEFAULT_TIMEZONE_OFFSET_MINUTES } from "./Matching/datetime.js";

import { DEFAULT_TIMEZONE_OFFSET_MINUTES } from "./Matching/datetime.js";

/**
 * Eski `KNOWN_ALIASES` sabiti. Artik tek dogru kaynak
 * ./Matching/team_aliases.json; bu nesne yalnizca disari acilan eski
 * API'yi kirmamak icin duruyor ve JSON'dan turetiliyor.
 */
export { KNOWN_ALIASES } from "./Matching/legacy-aliases.js";

/* =========================================================================
 * 1) SPOR ADI KANONİKLEŞTİRME
 * ====================================================================== */

/** Katalogda taninan her spor anahtari (isFetcherShape icin). */
const SPORT_KEYS = new Set(CATALOG_SPORT_ORDER);

export function canonicalSport(name) {
  const sport = resolveSport(name);

  if (sport) return sport.key;

  return name ? String(name).toUpperCase() : "BILINMEYEN";
}

// Lig alias indeksi, spor anahtarlarini katalogdan cozerek kurulur.
// Modul yuklenirken BIR KEZ; her karsilastirmada degil.
buildLeagueIndex((sportName) => resolveSport(sportName)?.key ?? null);

/* =========================================================================
 * 2) GİRDİYİ ORTAK MODELE İNDİRGEME
 * ====================================================================== */

/**
 * Ortak maç modeli:
 *   { site, sport, league, leagueRaw, country, leagueInfo,
 *     date, time, epoch, home, away, eventId }
 *
 * `leagueInfo` ve `epoch` BİR KEZ burada hesaplanır. Eskiden lig adı ve
 * tarih her karşılaştırmada yeniden parse ediliyordu; aday başına birkaç
 * yüz kez tekrar eden iş budur.
 */

/** Dosya, fetcher çıktısı yapısına uyuyor mu? */
export function isFetcherShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return Object.keys(data).some((k) => SPORT_KEYS.has(canonicalSport(k)));
}

/** Fetcher çıktısını düz maç listesine çevirir. */
export function parseFetcherOutput(
  data,
  site,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
  collector = null,
  sourceName = site
) {
  const out = [];

  for (const [sportRaw, leagues] of Object.entries(data)) {
    if (!leagues || typeof leagues !== "object") continue;

    const sport = canonicalSport(sportRaw);

    for (const [leagueKey, dates] of Object.entries(leagues)) {
      if (!dates || typeof dates !== "object") continue;

      // Lig anahtari "Ulke - Lig Adi" biciminde. Cozumleme LIG BASINA bir
      // kez yapilir, mac basina degil: gercek veride ~500 lig anahtarina
      // karsilik ~6300 mac var.
      const leagueInfo = resolveLeague(sport, leagueKey);

      if (collector && !leagueInfo.canonicalId) {
        collector.addLeague({
          source: sourceName,
          sport,
          country: leagueInfo.country,
          league: leagueInfo.name,
        });
      }

      for (const [date, matches] of Object.entries(dates)) {
        if (!Array.isArray(matches)) continue;

        for (const m of matches) {
          const stamp = normalizeTimestamp(date, m.time, offsetMinutes);

          out.push({
            site,
            sport,
            league: leagueInfo.name,
            leagueRaw: leagueKey,
            country: leagueInfo.countryRaw,
            leagueInfo,
            date,
            time: stamp.time,
            epoch: stamp.epoch,
            home: m.home ?? null,
            away: m.away ?? null,
            eventId: m.eventId != null ? String(m.eventId) : null,
          });
        }
      }
    }
  }

  return out;
}

/** Dosyayı doğrulayıp ortak modele çevirir. */
export function normalizeInput(
  data,
  site,
  {
    offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
    collector = null,
    sourceName = site,
  } = {}
) {
  if (!isFetcherShape(data)) {
    throw new Error(
      `"${site}" dosyası tanınmadı. Beklenen yapı: { "FUTBOL": { "Ülke - Lig": { "2026-09-18": [ ... ] } }, ... }`
    );
  }
  return {
    matches: parseFetcherOutput(
      data,
      site,
      offsetMinutes,
      collector,
      sourceName
    ),
  };
}

/* =========================================================================
 * 3) EŞLEŞTİRME
 * ====================================================================== */

/**
 * Varsayılanlar. Sayıların TEK doğru kaynağı ./Matching/config.js;
 * burası yalnızca eski `DEFAULTS` API'sini koruyan bir görünümdür.
 */
export const DEFAULTS = {
  teamThreshold: MATCH_CONFIG.teamThreshold,
  leagueThreshold: MATCH_CONFIG.leagueThreshold,
  requireLeague: MATCH_CONFIG.requireLeague,
  dateToleranceDays: MATCH_CONFIG.dateToleranceDays,
  toleranceMinutes: MATCH_CONFIG.toleranceMinutes,
  lowLeagueScore: MATCH_CONFIG.lowLeagueScore,
  teamScoreWhenLeagueLow: MATCH_CONFIG.teamScoreWhenLeagueLow,
  maxAdjacentDayDiffMinutes: MATCH_CONFIG.maxAdjacentDayDiffMinutes,
  crossDatePenalty: MATCH_CONFIG.crossDatePenalty,
  minConfidence: MATCH_CONFIG.possibleConfidence,
};

/**
 * İki listeyi eşleştirir.
 *
 * ESKİ HÂLİ: her maç için "spor|tarih" kovasındaki TÜM maçlarla tek tek
 * skorlanıyordu -> üç site için 979.978 aday çifti, 3.9 milyon bulanık
 * takım karşılaştırması, ~72 saniye.
 *
 * YENİ HÂLİ: aday havuzu takım adı ters indeksinden geliyor (bkz.
 * Matching/candidates.js) -> 43.501 aday çifti (%4.4), doğru eşleşmelerin
 * %99.95'i korunuyor.
 *
 * @returns {{pairs: Array, onlyA: Array, onlyB: Array}}
 */
export function matchLists(listA, listB, options = {}) {
  const opt = { ...DEFAULTS, ...options };

  // Hedef listenin hiyerarşik indeksi: sport -> date -> tokenPrefix.
  const index = buildMatchIndex(listB);

  const candidates = [];

  listA.forEach((a, ai) => {
    for (const bi of findMatchCandidates(a, index, opt)) {
      const b = listB[bi];

      const result = compareMatches(a, b, opt);
      if (!result.ok) continue;
      if (result.confidence < opt.minConfidence) continue;

      const crossDate = a.date !== b.date;

      candidates.push({
        ai,
        bi,
        teamScore: result.teamScore,
        leagueScore: result.leagueScore,
        flipped: result.flipped,
        confidence: result.confidence,
        decision: result.decision,
        diffMinutes: result.time?.diffMinutes ?? null,
        crossDate,
        // Sıralama skoru: takım ağırlıklı, lig ikincil, saat farkı üçüncül.
        // Aynı gün adayı komşu gün adayının HER ZAMAN önüne geçer; aynı
        // takımların hem bugün hem yarın kaydı varsa doğrusu aynı gündür.
        rank:
          result.teamScore * 1000 +
          result.leagueScore -
          (crossDate ? opt.crossDatePenalty : 0) -
          Math.min(Math.abs(result.time?.diffMinutes ?? 0), 999) / 1000,
      });
    }
  });

  // En iyi adaydan başlayarak tekil eşleştir (bir maç bir kez kullanılır).
  candidates.sort((x, y) => y.rank - x.rank);

  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];

  for (const c of candidates) {
    if (usedA.has(c.ai) || usedB.has(c.bi)) continue;
    usedA.add(c.ai);
    usedB.add(c.bi);

    pairs.push({
      a: listA[c.ai],
      b: listB[c.bi],
      indexA: c.ai,
      indexB: c.bi,
      teamScore: Math.round(c.teamScore * 10) / 10,
      leagueScore: Math.round(c.leagueScore * 10) / 10,
      confidence: Math.round(c.confidence * 1000) / 1000,
      decision: c.decision,
      flipped: c.flipped,
      diffMinutes: c.diffMinutes,
      crossDate: c.crossDate,
      isDifferent:
        c.diffMinutes == null
          ? false
          : Math.abs(c.diffMinutes) > opt.toleranceMinutes,
    });
  }

  return {
    pairs,
    onlyA: listA.filter((_, i) => !usedA.has(i)),
    onlyB: listB.filter((_, i) => !usedB.has(i)),
  };
}

/* =========================================================================
 * 6) ÇOK SİTELİ KÜMELEME
 *
 * İkiden fazla site karşılaştırırken "A ile B eşleşti", "B ile C eşleşti"
 * bilgilerini birleştirip AYNI MAÇI temsil eden kümeler oluşturmak gerekir.
 * Burada birleştir-bul (union-find) kullanıyoruz; tek kısıt: bir küme aynı
 * siteden EN FAZLA BİR maç içerebilir (aksi halde iki farklı maç yanlışlıkla
 * tek maça kaynardı).
 * ====================================================================== */

class DisjointSet {
  constructor() {
    this.parent = new Map();
  }

  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // yol sıkıştırma
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return true;
    this.parent.set(ra, rb);
    return true;
  }
}

/**
 * Site listelerini alıp aynı maçı temsil eden kümeleri üretir.
 *
 * @param {Record<string, Array>} bySite  site adı -> maç listesi
 * @returns {{clusters: Array, pairStats: Array}}
 */
export function clusterMatches(bySite, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const siteNames = Object.keys(bySite);

  // Global anahtar: "site#index"
  const keyOf = (site, index) => `${site}#${index}`;
  const entryOf = (key) => {
    const at = key.lastIndexOf("#");
    const site = key.slice(0, at);
    return { site, match: bySite[site][Number(key.slice(at + 1))] };
  };

  const ds = new DisjointSet();
  // Her kümenin hangi siteleri içerdiğini takip et (çakışmayı engellemek için)
  const clusterSites = new Map(); // kök -> Set(site)

  for (const site of siteNames) {
    bySite[site].forEach((_, i) => {
      const key = keyOf(site, i);
      ds.find(key);
      clusterSites.set(key, new Set([site]));
    });
  }

  const pairStats = [];

  // Tüm site çiftleri için ikili eşleştirme
  for (let i = 0; i < siteNames.length; i++) {
    for (let j = i + 1; j < siteNames.length; j++) {
      const siteA = siteNames[i];
      const siteB = siteNames[j];

      const { pairs } = matchLists(bySite[siteA], bySite[siteB], opt);

      for (const pair of pairs) {
        // matchLists artik indeksleri de donduruyor. Eskiden burada
        // `bySite[siteA].indexOf(pair.a)` cagriliyordu: her eslesme icin
        // 1500-2800 elemanli dizide dogrusal arama, yani eslesme sayisi x
        // liste uzunlugu kadar gereksiz is.
        const ia = pair.indexA;
        const ib = pair.indexB;
        if (ia == null || ib == null) continue;

        const ra = ds.find(keyOf(siteA, ia));
        const rb = ds.find(keyOf(siteB, ib));
        if (ra === rb) continue; // zaten aynı kümede (başka site üzerinden birleşmiş)

        const setA = clusterSites.get(ra) ?? new Set();
        const setB = clusterSites.get(rb) ?? new Set();

        // Aynı siteden iki maç tek kümeye giremez.
        let clash = false;
        for (const s of setB) if (setA.has(s)) clash = true;
        if (clash) continue;

        ds.union(ra, rb);
        const root = ds.find(ra);
        clusterSites.set(root, new Set([...setA, ...setB]));
      }

      // NOT: Burada GERÇEK eşleşme sayısını raporluyoruz. "Kaç tanesi yeni
      // birleşme yarattı" sayısı yanıltıcı olurdu: A-B ve A-C eşleştikten
      // sonra B-C zaten aynı kümede olduğu için 0 görünürdü.
      pairStats.push({ siteA, siteB, eslesen: pairs.length });
    }
  }

  // Kökleri toplayıp kümeleri kur
  const groups = new Map();

  for (const site of siteNames) {
    bySite[site].forEach((_, i) => {
      const key = keyOf(site, i);
      const root = ds.find(key);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(key);
    });
  }

  const clusters = [];

  for (const keys of groups.values()) {
    const entries = keys.map(entryOf);

    // Küme kimliği için ilk sitenin (TARGET sırasına göre) verisini temel al
    entries.sort(
      (x, y) => siteNames.indexOf(x.site) - siteNames.indexOf(y.site)
    );

    const bySiteMatch = {};
    for (const e of entries) bySiteMatch[e.site] = e.match;

    clusters.push({ entries, bySite: bySiteMatch });
  }

  return { clusters, pairStats };
}

/* =========================================================================
 * 7) ÇIKTI ÜRETİMİ
 * ====================================================================== */

const collator = new Intl.Collator("tr", {
  sensitivity: "base",
  numeric: true,
});
const SPORT_ORDER = CATALOG_SPORT_ORDER;
const sportRank = (s) => {
  const i = SPORT_ORDER.indexOf(s);
  return i === -1 ? SPORT_ORDER.length : i;
};

/** Bir küme için saat karşılaştırması yapar. */
function analyseCluster(cluster, siteNames, toleranceMinutes) {
  const present = siteNames.filter((s) => cluster.bySite[s]);
  const missing = siteNames.filter((s) => !cluster.bySite[s]);

  const epochs = present
    .map((s) => ({ site: s, epoch: cluster.bySite[s].epoch }))
    .filter((x) => x.epoch != null);

  if (epochs.length < 2) {
    return {
      present,
      missing,
      maxDiffMinutes: 0,
      isDifferent: false,
      deviating: [],
    };
  }

  const values = epochs.map((x) => x.epoch);
  const maxDiffMinutes = Math.round(
    (Math.max(...values) - Math.min(...values)) / 60000
  );

  // Referans: en çok tekrar eden saat (eşitlik olursa en erken).
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  let reference = values[0];
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < reference)) {
      reference = value;
      bestCount = count;
    }
  }

  const deviating = epochs
    .filter((x) => Math.abs(x.epoch - reference) > toleranceMinutes * 60000)
    .map((x) => ({
      site: x.site,
      farkDakika: Math.round((x.epoch - reference) / 60000),
    }));

  return {
    present,
    missing,
    maxDiffMinutes,
    isDifferent: maxDiffMinutes > toleranceMinutes,
    deviating,
  };
}

function clusterToRow(cluster, siteNames, analysis) {
  // Görünen ad için ilk mevcut siteyi kullan
  const first = cluster.bySite[analysis.present[0]];

  const saatler = {};
  const tarihler = {};
  const ligler = {};
  const takimlar = {};

  for (const site of siteNames) {
    const m = cluster.bySite[site];
    if (!m) continue;
    saatler[site] = m.time;
    tarihler[site] = m.date;
    ligler[site] = m.leagueRaw;
    takimlar[site] = `${m.home} - ${m.away}`;
  }

  // Siteler macin GUNU konusunda da anlasmazsa bunu ayrica isaretle.
  // Tek basina "1380 dakika fark" yaniltici olurdu: gerceklesen sey
  // saatin degil TARIHIN farkli yazilmasidir.
  const gunler = new Set(Object.values(tarihler));
  const tarihFarkli = gunler.size > 1;

  return {
    sport: first.sport,
    league: first.league,
    date: first.date,
    home: first.home,
    away: first.away,
    saatler,
    tarihler,
    tarihFarkli,
    maxFarkDakika: analysis.maxDiffMinutes,
    sapanSiteler: analysis.deviating,
    eksikSiteler: analysis.missing,
    ligler,
    takimlar,
  };
}

/** Düz satır listesini SPOR -> LİG -> TARİH ağacına çevirir. */
function groupRows(rows) {
  const tree = {};
  for (const r of rows) {
    tree[r.sport] ??= {};
    tree[r.sport][r.league] ??= {};
    tree[r.sport][r.league][r.date] ??= [];
    tree[r.sport][r.league][r.date].push(r);
  }

  const sorted = {};
  for (const sport of Object.keys(tree).sort(
    (x, y) => sportRank(x) - sportRank(y) || collator.compare(x, y)
  )) {
    sorted[sport] = {};
    for (const league of Object.keys(tree[sport]).sort(collator.compare)) {
      sorted[sport][league] = {};
      for (const date of Object.keys(tree[sport][league]).sort()) {
        sorted[sport][league][date] = tree[sport][league][date].sort(
          (p, q) =>
            String(Object.values(p.saatler)[0] ?? "").localeCompare(
              String(Object.values(q.saatler)[0] ?? "")
            ) || collator.compare(`${p.home} ${p.away}`, `${q.home} ${q.away}`)
        );
      }
    }
  }
  return sorted;
}

/** "dizin/betist-matches.json" -> "betist" */
function siteNameFromPath(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? "site";
  return base.replace(/\.json$/i, "").replace(/[-_]?matches?$/i, "") || base;
}

/** Aynı ada sahip dosyalar varsa sonuna sayı ekleyerek ayır. */
function uniqueSiteNames(filePaths) {
  const names = filePaths.map(siteNameFromPath);
  const seen = new Map();
  return names.map((n) => {
    const count = (seen.get(n) ?? 0) + 1;
    seen.set(n, count);
    return count === 1 ? n : `${n}_${count}`;
  });
}

/**
 * Uçtan uca: 2 veya daha fazla dosyayı oku, karşılaştır, sonucu döndür.
 *
 * @param {string[]} filePaths
 * @param {object} options
 */
export async function compareFiles(filePaths, options = {}) {
  const opt = { ...DEFAULTS, includeUnmatched: false, flat: false, ...options };

  if (filePaths.length < 2) {
    throw new Error("En az iki dosya gerekli.");
  }

  const allSiteNames = uniqueSiteNames(filePaths);

  const bySite = {};
  const kaynaklar = {};
  const okunamayan = [];

  // Alias veritabaninda karsiligi olmayan lig/takim adlarini topla.
  // Varsayilan KAPALI (MATCH_DEBUG_UNRESOLVED=1 ile acilir) -- production'da
  // her kosuda binlerce satir log uretmesin.
  const collector = new UnresolvedCollector({
    enabled: opt.collectUnresolved ?? MATCH_CONFIG.collectUnresolved,
  });

  // Bir fetcher calismadiysa dosyasi eksik/bozuk olabilir. Eskiden bu durum
  // tum karsilastirmayi patlatiyor, elde olan iki saglam dosya da
  // degerlendirilemiyordu. Artik bozuk dosya atlanip sebebi raporlaniyor.
  for (let i = 0; i < filePaths.length; i++) {
    const site = allSiteNames[i];

    try {
      const raw = JSON.parse(await readFile(filePaths[i], "utf8"));
      // `site` (kisa ad) raporlarda kullanilir; dosya yolu yalnizca hata
      // mesajinda anlamli oldugu icin normalizeInput'a o gidiyor.
      const parsed = normalizeInput(raw, filePaths[i], {
        ...opt,
        collector,
        sourceName: site,
      });

      bySite[site] = parsed.matches.map((m) => ({ ...m, site }));

      if (collector.enabled) {
        for (const m of bySite[site]) {
          for (const team of [m.home, m.away]) {
            collector.addTeam({
              source: site,
              sport: m.sport,
              league: m.leagueRaw,
              team,
            });
          }
        }
      }
      kaynaklar[site] = { dosya: filePaths[i], macSayisi: bySite[site].length };
    } catch (error) {
      okunamayan.push({ site, dosya: filePaths[i], hata: error.message });
      console.warn(`[COMPARE] ${filePaths[i]} okunamadi: ${error.message}`);
    }
  }

  const siteNames = allSiteNames.filter((site) => bySite[site]);

  if (siteNames.length < 2) {
    throw new Error(
      `Karsilastirma icin en az iki okunabilir dosya gerekli (okunan: ${siteNames.length}).`
    );
  }

  const { clusters, pairStats } = clusterMatches(bySite, opt);

  const analysed = clusters.map((c) => ({
    cluster: c,
    analysis: analyseCluster(c, siteNames, opt.toleranceMinutes),
  }));

  // Sadece BİRDEN FAZLA sitede bulunan maçlar karşılaştırılabilir.
  const comparable = analysed.filter((x) => x.analysis.present.length > 1);
  const different = comparable.filter((x) => x.analysis.isDifferent);

  const rows = different.map((x) =>
    clusterToRow(x.cluster, siteNames, x.analysis)
  );

  // Site bazında istatistik
  const siteBazinda = {};
  for (const site of siteNames) {
    const only = analysed.filter(
      (x) => x.analysis.present.length === 1 && x.analysis.present[0] === site
    ).length;
    siteBazinda[site] = {
      toplam: bySite[site].length,
      sadeceBuSitede: only,
    };
  }

  // Kaç sitede birden göründüğüne göre dağılım
  const kapsam = {};
  for (const x of analysed) {
    const n = x.analysis.present.length;
    const key = `${n}_sitede`;
    kapsam[key] = (kapsam[key] ?? 0) + 1;
  }

  const result = {
    olusturulma: new Date().toISOString(),
    siteler: siteNames,
    kaynaklar,
    okunamayan,
    ayarlar: {
      toleransDakika: opt.toleranceMinutes,
      takimEsigi: opt.teamThreshold,
      ligEsigi: opt.leagueThreshold,
      ligZorunlu: opt.requireLeague,
      tarihToleransGun: opt.dateToleranceDays,
    },
    ozet: {
      toplamMacGrubu: analysed.length,
      karsilastirilabilir: comparable.length,
      saatiFarkli: different.length,
      saatiAyni: comparable.length - different.length,
      kapsam,
      siteBazinda,
      ikiliEslesme: pairStats,
    },
    farkliMaclar: opt.flat ? rows : groupRows(rows),
  };

  // ONERI, OTOMATIK ALIAS DEGILDIR: bulanik eslestiricinin bulduklari
  // alias dosyalarina yazilmaz, yalnizca insan onayina sunulur. Yanlis bir
  // alias butun eslestirme sistemini sessizce bozar.
  const cozulemeyen = collector.report();
  if (cozulemeyen) result.cozulemeyen = cozulemeyen;

  if (opt.includeUnmatched) {
    const slim = (m) => ({
      sport: m.sport,
      league: m.leagueRaw,
      date: m.date,
      time: m.time,
      home: m.home,
      away: m.away,
      eventId: m.eventId,
    });

    const eslesmeyenler = {};
    for (const site of siteNames) {
      eslesmeyenler[site] = analysed
        .filter(
          (x) =>
            x.analysis.present.length === 1 && x.analysis.present[0] === site
        )
        .map((x) => slim(x.cluster.bySite[site]));
    }
    result.eslesmeyenler = eslesmeyenler;
  }

  return result;
}

/* =========================================================================
 * 8) KOMUT SATIRI
 * ====================================================================== */

function parseArgs(argv) {
  const files = [];
  const options = { out: null, summary: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--out") options.out = argv[++i];
    else if (arg === "--tolerans" || arg === "--tolerance")
      options.toleranceMinutes = Number(argv[++i]);
    else if (arg === "--takim-esigi") options.teamThreshold = Number(argv[++i]);
    else if (arg === "--lig-esigi") options.leagueThreshold = Number(argv[++i]);
    else if (arg === "--lig-zorunlu") options.requireLeague = true;
    else if (arg === "--tarih-tolerans")
      options.dateToleranceDays = Number(argv[++i]);
    else if (arg === "--eslesmeyenler") options.includeUnmatched = true;
    else if (arg === "--duz" || arg === "--flat") options.flat = true;
    else if (arg === "--ozet" || arg === "--summary") options.summary = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else files.push(arg);
  }
  return { files, options };
}

function printHelp() {
  console.log(`
Maç saati karşılaştırıcı (spor -> lig -> tarih -> takım eşleştirmesi)
2, 3 veya daha fazla site çıktısını aynı anda karşılaştırır.

Kullanım:
  node mac-saati-karsilastir.js betist-matches.json mavibet-matches.json virusbet-matches.json -o farkli.json

Seçenekler:
  -o, --out <dosya>       Sonucu dosyaya yaz (varsayılan: ekrana bas)
      --ozet              JSON yerine kısa özet tablo göster
      --tolerans <dk>     Bu kadar veya daha az farkı "aynı" say (varsayılan: 0)
      --takim-esigi <n>   Takım adı benzerlik eşiği 0-100 (varsayılan: ${DEFAULTS.teamThreshold})
      --lig-esigi <n>     Lig adı benzerlik eşiği 0-100 (varsayılan: ${DEFAULTS.leagueThreshold})
      --lig-zorunlu       Lig eşleşmesini zorunlu kıl (varsayılan: sadece ağırlık)
      --tarih-tolerans <g> Gün toleransı (varsayılan: ${DEFAULTS.dateToleranceDays}, gece yarısı kaymaları için)
      --eslesmeyenler     Çıktıya sadece tek sitede olan maçları da ekle
      --duz               Gruplamadan düz liste üret
  -h, --help              Bu yardım

Girdi dosyaları betist / mavibet / virusbet fetcher çıktılarıdır (hepsi aynı
yapıda). Sıra önemli değildir; site adları dosya adlarından türetilir.
`);
}

function printSummary(result) {
  const siteler = result.siteler;
  const pad = Math.max(...siteler.map((s) => s.length), 10);

  console.log("");
  for (const [name, src] of Object.entries(result.kaynaklar)) {
    console.log(
      `  ${name.padEnd(pad)}  ${String(src.macSayisi).padStart(5)} maç   (${src.dosya})`
    );
  }

  console.log("");
  console.log(`  Toplam maç grubu     : ${result.ozet.toplamMacGrubu}`);
  console.log(
    `  Karşılaştırılabilir  : ${result.ozet.karsilastirilabilir}  (2+ sitede var)`
  );
  console.log(`  SAATİ FARKLI         : ${result.ozet.saatiFarkli}`);
  console.log(`  Saati aynı           : ${result.ozet.saatiAyni}`);

  console.log("");
  console.log("  Kaç sitede bulundu:");
  for (const [key, count] of Object.entries(result.ozet.kapsam).sort()) {
    console.log(`    ${key.replace("_", " ")}: ${count}`);
  }

  console.log("");
  console.log("  İkili eşleşmeler:");
  for (const p of result.ozet.ikiliEslesme) {
    console.log(`    ${p.siteA} <-> ${p.siteB}: ${p.eslesen}`);
  }

  console.log("");
  const tree = result.farkliMaclar;

  if (Array.isArray(tree)) {
    for (const r of tree) {
      console.log(
        `  ${r.sport} | ${r.league} | ${r.date} | ${r.home} - ${r.away}`
      );
      console.log(`      ${formatTimes(r, siteler)}`);
    }
    return;
  }

  for (const [sport, leagues] of Object.entries(tree)) {
    console.log(`${sport}`);
    for (const [league, dates] of Object.entries(leagues)) {
      console.log(`  ${league}`);
      for (const [date, rows] of Object.entries(dates)) {
        for (const r of rows) {
          console.log(
            `    ${date}  ${r.home} - ${r.away}   (maks fark ${r.maxFarkDakika} dk)`
          );
          console.log(`        ${formatTimes(r, siteler)}`);
        }
      }
    }
    console.log("");
  }
}

function formatTimes(row, siteler) {
  return siteler
    .map((s) => {
      const time = row.saatler[s];
      if (!time) return `${s}: -`;
      const dev = row.sapanSiteler.find((d) => d.site === s);
      const mark = dev
        ? ` (${dev.farkDakika > 0 ? "+" : ""}${dev.farkDakika})`
        : "";
      return `${s}: ${time}${mark}`;
    })
    .join("   ");
}

async function compareMatchTimesMain() {
  const args = [
    "./virus_bet-matches.json",
    "./mavi_bet-matches.json",
    "./betist-matches.json",
    "-o",
    "match-times-diff.json",
  ];

  console.log(args);

  const { files, options } = parseArgs(args);

  if (options.help || files.length < 2) {
    printHelp();
    // process.exit(options.help ? 0 : 1);
  }

  const result = await compareFiles(files, options);

  if (options.summary) {
    printSummary(result);
    return;
  }

  const json = JSON.stringify(result, null, 2);
  if (options.out) {
    await writeFile(options.out, json, "utf8");
    console.log(
      `Yazıldı: ${options.out}  (${result.ozet.saatiFarkli} farklı maç)`
    );
  } else {
    console.log(json);
  }
}

export { compareMatchTimesMain };

// Doğrudan çalıştırıldığında CLI; import edildiğinde sadece fonksiyonlar.
// if (
//   process.argv[1] &&
//   import.meta.url === new URL(`file://${process.argv[1]}`).href
// ) {
//   compareMatchTimesMain().catch((error) => {
//     console.error("Hata:", error.message);
//     process.exitCode = 1;
//   });
// }
