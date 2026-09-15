#!/usr/bin/env node
/**
 * MAÇ SAATİ KARŞILAŞTIRICI  (ES6 / ESM, sıfır bağımlılık, Node 18+)
 *
 * İki farklı sitenin maç listesini karşılaştırır ve AYNI maçın iki sitede
 * FARKLI saatte gösterildiği durumları JSON olarak verir.
 *
 * Girdi olarak şu iki dosyayı alır:
 *   1) betist-match-fetcher.js çıktısı  (betist-matches.json)
 *      Yapı:  { "FUTBOL": { "Ülke - Lig": { "2026-09-18": [ {home,away,time,...} ] } }, ... }
 *
 *   2) mavibet-match-fetcher.js / cli.js çıktısı  (maclar.json)
 *      Yapı:  { sports: [ { sportName, leagues: [ { leagueName, dates: [ { date, matches: [...] } ] } ] } ] }
 *
 * Hangi dosyanın hangi formatta olduğu OTOMATİK algılanır; sırayı
 * karıştırmanız sorun olmaz.
 *
 * ---------------------------------------------------------------------------
 * EŞLEŞTİRME MANTIĞI (istenen sıra: spor -> lig -> tarih -> takım)
 *
 *   1) SPOR    : "FUTBOL" / "Futbol" / "Soccer" gibi farklı yazımlar tek bir
 *                kanonik anahtara indirgenir. Farklı spor = asla eşleşmez.
 *
 *   2) TARİH   : Aynı güne düşen maçlar aday havuzuna alınır. ÖNEMLİ: bir
 *                site 23:50, diğeri 00:10 gösteriyorsa TARİHLER DE FARKLI
 *                olur; bu yüzden ±1 gün komşuluğuna da bakılır, yoksa asıl
 *                yakalamak istediğiniz "gece yarısını aşan" farklar gözden
 *                kaçardı.
 *
 *   3) LİG     : Lig adları siteler arasında çok farklı yazılabildiği için
 *                (ör. "Türkiye - Türkiye Süper Lig" vs "Türkiye Süper Lig
 *                2026/2027") ZORUNLU tutulmaz; benzerlik skoru hesaplanıp
 *                aday sıralamasında ağırlık olarak kullanılır. İsterseniz
 *                --lig-zorunlu ile zorunlu hale getirebilirsiniz.
 *
 *   4) TAKIM   : Asıl belirleyici adım. Takım adları normalize edilip
 *                (Türkçe karakter katlama, sezon/jenerik ek temizliği,
 *                kısaltma sözlükleri) bulanık (fuzzy) karşılaştırılır.
 *                Ev/deplasman sırası ters olabilir diye çapraz da denenir.
 *
 *   Adaylar global olarak skora göre sıralanıp tek tek eşleştirilir
 *   (bir maç yalnızca bir kez kullanılabilir).
 *
 * ---------------------------------------------------------------------------
 * KULLANIM
 *
 *   node mac-saati-karsilastir.js betist-matches.json maclar.json -o farkli.json
 *   node mac-saati-karsilastir.js *.json --summary
 *   node mac-saati-karsilastir.js a.json b.json --tolerans 5      (5 dk'ya kadar farkı yok say)
 *   node mac-saati-karsilastir.js a.json b.json --eslesmeyenler   (çıktıya eşleşmeyenleri de ekle)
 *   node mac-saati-karsilastir.js a.json b.json --duz             (gruplamadan düz liste)
 */

import { readFile, writeFile } from "node:fs/promises";

export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 180; // Europe/Istanbul = UTC+3 (yaz saati yok)

/* =========================================================================
 * 1) METİN NORMALİZASYONU VE BULANIK (FUZZY) KARŞILAŞTIRMA
 * ====================================================================== */

const TR_MAP = {
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ı: "i",
  I: "i",
  İ: "i",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
};

/** Takım adlarında sık geçen, eşleştirmeyi bozabilecek jenerik ekler.
 * Bilinçli olarak kısa tutuldu; agresif temizlik yanlış eşleşme üretir. */
const GENERIC_TOKENS = new Set([
  "fc",
  "cf",
  "sk",
  "ac",
  "sc",
  "cd",
  "ud",
  "if",
  "bk",
  "fk",
  "sv",
  "vfl",
  "vfb",
  "as",
  "ss",
]);

/** Bilinen kısaltma / takma adlar. Anahtar ve değer, foldText() çıktısı
 * biçiminde (küçük harf, Türkçe karakterler katlanmış) olmalı.
 * Buraya ihtiyaç duydukça ekleme yapabilirsiniz. */
export const KNOWN_ALIASES = {
  "m united": "manchester united",
  "man united": "manchester united",
  "man utd": "manchester united",
  "manchester utd": "manchester united",
  "m city": "manchester city",
  "man city": "manchester city",
  psg: "paris saint germain",
  "paris sg": "paris saint germain",
  bvb: "borussia dortmund",
  "b dortmund": "borussia dortmund",
  gladbach: "borussia monchengladbach",
  bayern: "bayern munich",
  "atl madrid": "atletico madrid",
  atm: "atletico madrid",
  inter: "internazionale",
  spurs: "tottenham hotspur",
  tottenham: "tottenham hotspur",
  wolves: "wolverhampton wanderers",
  fener: "fenerbahce",
  cimbom: "galatasaray",
  "kara kartal": "besiktas",
};

/** ABD ligleri (NBA/NFL/MLB/NHL) için şehir kısaltmaları. */
export const CITY_ABBREVIATIONS = {
  ny: "new york",
  la: "los angeles",
  sa: "san antonio",
  sf: "san francisco",
  gs: "golden state",
  okc: "oklahoma city",
  no: "new orleans",
  kc: "kansas city",
  gb: "green bay",
  ne: "new england",
  tb: "tampa bay",
  lv: "las vegas",
};

/** Küçük harfe çevirir, Türkçe karakterleri katlar, diğer aksanları
 * sadeleştirir, noktalamayı atar, boşlukları teke indirir. */
export function foldText(text) {
  if (!text) return "";
  let t = String(text).trim().toLowerCase();
  t = t.replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch);
  t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  t = t.replace(/[.\-'’`]/g, " ");
  t = t.replace(/[^a-z0-9\s]/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

function expandCityAbbrev(tokens) {
  const out = [];
  for (const t of tokens) {
    if (CITY_ABBREVIATIONS[t]) out.push(...CITY_ABBREVIATIONS[t].split(" "));
    else out.push(t);
  }
  return out;
}

export function normalizeTeamName(name) {
  let folded = foldText(name);
  if (KNOWN_ALIASES[folded]) folded = KNOWN_ALIASES[folded];
  folded = expandCityAbbrev(folded.split(" ")).join(" ");
  const stripped = folded
    .split(" ")
    .filter((t) => t && !GENERIC_TOKENS.has(t))
    .join(" ");
  return stripped || folded;
}

// Sezon bilgisi ("2026", "2026/2027", "2026-27") - foldText'ten ÖNCE
// temizlenir, çünkü "/" sonradan boşluğa dönüşüp "27" gibi artık bırakır.
const SEASON_RE = /\b(19|20)\d{2}([/-](19|20)?\d{2})?\b/g;

export function normalizeLeagueName(name) {
  return foldText(String(name ?? "").replace(SEASON_RE, " "));
}

/** Levenshtein (düzenleme) mesafesi - saf JS. */
function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1),
    curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function charRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return Math.max(0, 1 - levenshtein(a, b) / maxLen) * 100;
}

const tokenSort = (t) => t.split(" ").filter(Boolean).sort().join(" ");
const isAbbrev = (short, long) =>
  short.length >= 1 && short.length < long.length && long.startsWith(short);

/** Kelime sırasına duyarsız, baş harf kısaltmalarını tanıyan örtüşme oranı.
 * "Ferro, Fiona" ~ "Fiona Ferro", "Recek D / Siniakov D" ~ "D. Recek / D. Siniakov" */
function tokenOverlapRatio(a, b) {
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const used = new Array(tb.length).fill(false);
  let matched = 0;
  for (const x of ta) {
    for (let j = 0; j < tb.length; j++) {
      if (used[j]) continue;
      if (x === tb[j] || isAbbrev(x, tb[j]) || isAbbrev(tb[j], x)) {
        used[j] = true;
        matched++;
        break;
      }
    }
  }
  return (100 * matched) / Math.max(ta.length, tb.length);
}

/** "NY" ~ "New York" gibi birleşik baş harf kısaltmaları. */
function initialsRatio(a, b) {
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  if (ta.length < 2 && tb.length < 2) return 0;
  const dir = (shortT, longT) => {
    if (longT.length < 2) return 0;
    const ini = longT.map((t) => t[0]).join("");
    let best = 0;
    for (const s of shortT) {
      if (s.length < 2) continue;
      if (ini.startsWith(s) || s === ini)
        best = Math.max(best, (100 * s.length) / ini.length);
    }
    return best;
  };
  return Math.max(dir(ta, tb), dir(tb, ta));
}

export function similarityRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  return Math.max(
    charRatio(a, b),
    charRatio(tokenSort(a), tokenSort(b)),
    tokenOverlapRatio(a, b),
    initialsRatio(a, b)
  );
}

export const teamSimilarity = (a, b) =>
  similarityRatio(normalizeTeamName(a), normalizeTeamName(b));
export const leagueSimilarity = (a, b) =>
  similarityRatio(normalizeLeagueName(a), normalizeLeagueName(b));

/* =========================================================================
 * 2) SPOR ADI KANONİKLEŞTİRME
 * ====================================================================== */

const SPORT_CANON = new Map([
  ["futbol", "FUTBOL"],
  ["soccer", "FUTBOL"],
  ["football", "FUTBOL"],
  ["basketbol", "BASKETBOL"],
  ["basketball", "BASKETBOL"],
  ["voleybol", "VOLEYBOL"],
  ["volleyball", "VOLEYBOL"],
  ["tenis", "TENIS"],
  ["tennis", "TENIS"],
]);

export function canonicalSport(name) {
  return (
    SPORT_CANON.get(foldText(name)) ??
    (name ? String(name).toUpperCase() : "BILINMEYEN")
  );
}

/* =========================================================================
 * 3) TARİH / SAAT
 * ====================================================================== */

/** "2026-09-18" + "20:00" -> epoch ms (yerel saat UTC+3 kabul edilerek).
 * Gece yarısını aşan farkları doğru hesaplamak için tek bir sayıya
 * indirgemek şart; sadece "HH:MM" string karşılaştırması 23:50 vs 00:10
 * durumunu 23 saat 40 dk fark sanırdı. */
export function toEpochMs(
  date,
  time,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES
) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(time ?? ""));
  if (!d || !t) return null;
  return (
    Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]) - offsetMinutes * 60_000
  );
}

const DAY_MS = 86_400_000;
const dateKeyOffset = (date, days) => {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  if (!d) return null;
  return new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
};

/* =========================================================================
 * 4) GİRDİYİ ORTAK MODELE İNDİRGEME
 * ====================================================================== */

/**
 * Her iki fetcher da AYNI yapıda JSON üretiyor:
 *
 *   { "FUTBOL": { "Ülke - Lig": { "2026-09-18": [ {eventId,leagueId,home,away,time} ] } }, ... }
 *
 * Ortak maç modeli:
 *   { site, sport, league, leagueRaw, country, date, time, epoch, home, away, eventId }
 */

/** Dosya, fetcher çıktısı yapısına uyuyor mu? */
export function isFetcherShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return Object.keys(data).some((k) => SPORT_CANON.has(foldText(k)));
}

/** Fetcher çıktısını düz maç listesine çevirir. */
export function parseFetcherOutput(
  data,
  site,
  offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES
) {
  const out = [];

  for (const [sportRaw, leagues] of Object.entries(data)) {
    if (!leagues || typeof leagues !== "object") continue;

    const sport = canonicalSport(sportRaw);

    for (const [leagueKey, dates] of Object.entries(leagues)) {
      if (!dates || typeof dates !== "object") continue;

      // Lig anahtarı "Ülke - Lig Adı" biçiminde; ikisini ayırıp hem ülkeyi
      // hem sade lig adını elde ediyoruz (lig benzerliği için daha isabetli).
      const sep = leagueKey.indexOf(" - ");
      const country = sep > -1 ? leagueKey.slice(0, sep).trim() : null;
      const league =
        sep > -1 ? leagueKey.slice(sep + 3).trim() : leagueKey.trim();

      for (const [date, matches] of Object.entries(dates)) {
        if (!Array.isArray(matches)) continue;

        for (const m of matches) {
          out.push({
            site,
            sport,
            league,
            leagueRaw: leagueKey,
            country,
            date,
            time: m.time ?? null,
            epoch: toEpochMs(date, m.time, offsetMinutes),
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
  { offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES } = {}
) {
  if (!isFetcherShape(data)) {
    throw new Error(
      `"${site}" dosyası tanınmadı. Beklenen yapı: { "FUTBOL": { "Ülke - Lig": { "2026-09-18": [ ... ] } }, ... }`
    );
  }
  return { matches: parseFetcherOutput(data, site, offsetMinutes) };
}

/* =========================================================================
 * 5) EŞLEŞTİRME VE KARŞILAŞTIRMA
 * ====================================================================== */

export const DEFAULTS = {
  teamThreshold: 78, // iki maçın "aynı maç" sayılması için takım skoru eşiği
  leagueThreshold: 55, // lig "aynı" sayılsın diye gereken skor (zorunlu değilse sadece ağırlık)
  requireLeague: false, // true -> lig eşleşmesi ZORUNLU
  dateToleranceDays: 1, // gece yarısını aşan kaymaları yakalamak için ±1 gün
  toleranceMinutes: 0, // bu kadar veya daha az fark "aynı" sayılır
};

/** İki maç için (takım skoru, lig skoru, ters mi) hesaplar.
 * Ev/deplasman sırası siteler arasında ters olabileceği için çapraz da denenir. */
function scorePair(a, b, teamThreshold) {
  const hh = teamSimilarity(a.home, b.home);
  const aa = teamSimilarity(a.away, b.away);
  const straightOk = hh >= teamThreshold && aa >= teamThreshold;
  const straight = (hh + aa) / 2;

  const ha = teamSimilarity(a.home, b.away);
  const ah = teamSimilarity(a.away, b.home);
  const crossOk = ha >= teamThreshold && ah >= teamThreshold;
  const cross = (ha + ah) / 2;

  let teamScore, flipped, ok;
  if (straightOk && (!crossOk || straight >= cross)) {
    teamScore = straight;
    flipped = false;
    ok = true;
  } else if (crossOk) {
    teamScore = cross;
    flipped = true;
    ok = true;
  } else {
    teamScore = Math.max(straight, cross);
    flipped = cross > straight;
    ok = false;
  }

  return {
    ok,
    teamScore,
    flipped,
    leagueScore: leagueSimilarity(a.league, b.league),
  };
}

/**
 * İki listeyi eşleştirir.
 * @returns {{pairs: Array, onlyA: Array, onlyB: Array}}
 */
export function matchLists(listA, listB, options = {}) {
  const opt = { ...DEFAULTS, ...options };

  // Spor + tarih kovalarına ayır (aday sayısını düşürmek için).
  const indexB = new Map();
  listB.forEach((m, i) => {
    const key = `${m.sport}|${m.date}`;
    if (!indexB.has(key)) indexB.set(key, []);
    indexB.get(key).push(i);
  });

  // Tüm makul adayları skorla.
  const candidates = [];
  listA.forEach((a, ai) => {
    const seen = new Set();
    for (let d = -opt.dateToleranceDays; d <= opt.dateToleranceDays; d++) {
      const date = d === 0 ? a.date : dateKeyOffset(a.date, d);
      if (!date) continue;
      for (const bi of indexB.get(`${a.sport}|${date}`) ?? []) {
        if (seen.has(bi)) continue;
        seen.add(bi);

        const b = listB[bi];
        const s = scorePair(a, b, opt.teamThreshold);
        if (!s.ok) continue;
        if (opt.requireLeague && s.leagueScore < opt.leagueThreshold) continue;

        candidates.push({
          ai,
          bi,
          teamScore: s.teamScore,
          leagueScore: s.leagueScore,
          flipped: s.flipped,
          // Sıralama skoru: takım ağırlıklı, lig ikincil, saat farkı üçüncül.
          // (Aynı takımların aynı gün iki maçı varsa saati yakın olanı tercih et.)
          rank:
            s.teamScore * 1000 +
            s.leagueScore -
            Math.min(Math.abs((a.epoch ?? 0) - (b.epoch ?? 0)) / 60000, 999) /
              1000,
        });
      }
    }
  });

  // En iyi adaydan başlayarak tekil eşleştir.
  candidates.sort((x, y) => y.rank - x.rank);
  const usedA = new Set(),
    usedB = new Set();
  const pairs = [];

  for (const c of candidates) {
    if (usedA.has(c.ai) || usedB.has(c.bi)) continue;
    usedA.add(c.ai);
    usedB.add(c.bi);

    const a = listA[c.ai],
      b = listB[c.bi];
    const diffMinutes =
      a.epoch != null && b.epoch != null
        ? Math.round((b.epoch - a.epoch) / 60000)
        : null;

    pairs.push({
      a,
      b,
      teamScore: Math.round(c.teamScore * 10) / 10,
      leagueScore: Math.round(c.leagueScore * 10) / 10,
      flipped: c.flipped,
      diffMinutes,
      isDifferent:
        diffMinutes == null
          ? false
          : Math.abs(diffMinutes) > opt.toleranceMinutes,
    });
  }

  return {
    pairs,
    onlyA: listA.filter((_, i) => !usedA.has(i)),
    onlyB: listB.filter((_, i) => !usedB.has(i)),
  };
}

/* =========================================================================
 * 6) ÇIKTI ÜRETİMİ
 * ====================================================================== */

const collator = new Intl.Collator("tr", {
  sensitivity: "base",
  numeric: true,
});
const SPORT_ORDER = ["FUTBOL", "BASKETBOL", "VOLEYBOL", "TENIS"];
const sportRank = (s) => {
  const i = SPORT_ORDER.indexOf(s);
  return i === -1 ? SPORT_ORDER.length : i;
};

function pairToRow(pair, nameA, nameB) {
  const { a, b } = pair;
  return {
    sport: a.sport,
    league: a.league,
    date: a.date,
    home: a.home,
    away: a.away,
    [nameA]: {
      date: a.date,
      time: a.time,
      league: a.leagueRaw,
      home: a.home,
      away: a.away,
      eventId: a.eventId,
    },
    [nameB]: {
      date: b.date,
      time: b.time,
      league: b.leagueRaw,
      home: b.home,
      away: b.away,
      eventId: b.eventId,
    },
    diffMinutes: pair.diffMinutes,
    // + ise 2. site daha GEÇ, - ise daha ERKEN gösteriyor
    fark: `${pair.diffMinutes > 0 ? "+" : ""}${pair.diffMinutes} dk`,
    takimSkoru: pair.teamScore,
    ligSkoru: pair.leagueScore,
    ...(pair.flipped ? { evDeplasmanTers: true } : {}),
  };
}

/** Düz satır listesini SPOR -> LİG -> TARİH ağacına çevirir. */
function groupRows(rows, nameA) {
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
            String(p[nameA]?.time ?? "").localeCompare(
              String(q[nameA]?.time ?? "")
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

/**
 * Uçtan uca: iki dosyayı oku, karşılaştır, sonucu döndür.
 *
 * @param {string} fileA
 * @param {string} fileB
 * @param {object} options
 */
export async function compareFiles(fileA, fileB, options = {}) {
  const opt = { ...DEFAULTS, includeUnmatched: false, flat: false, ...options };

  const [rawA, rawB] = await Promise.all([
    readFile(fileA, "utf8").then(JSON.parse),
    readFile(fileB, "utf8").then(JSON.parse),
  ]);

  const parsedA = normalizeInput(rawA, fileA, opt);
  const parsedB = normalizeInput(rawB, fileB, opt);

  // Site adları dosya adından türetilir:
  //   "betist-matches.json"  -> "betist"
  //   "mavibet-matches.json" -> "mavibet"
  let nameA = opt.nameA || siteNameFromPath(fileA);
  let nameB = opt.nameB || siteNameFromPath(fileB);
  if (nameA === nameB) {
    nameA = `${nameA}_1`;
    nameB = `${nameB}_2`;
  }

  const listA = parsedA.matches.map((m) => ({ ...m, site: nameA }));
  const listB = parsedB.matches.map((m) => ({ ...m, site: nameB }));

  const { pairs, onlyA, onlyB } = matchLists(listA, listB, opt);

  const differentPairs = pairs.filter((p) => p.isDifferent);
  const rows = differentPairs.map((p) => pairToRow(p, nameA, nameB));

  const result = {
    olusturulma: new Date().toISOString(),
    kaynaklar: {
      [nameA]: { dosya: fileA, macSayisi: listA.length },
      [nameB]: { dosya: fileB, macSayisi: listB.length },
    },
    ayarlar: {
      toleransDakika: opt.toleranceMinutes,
      takimEsigi: opt.teamThreshold,
      ligEsigi: opt.leagueThreshold,
      ligZorunlu: opt.requireLeague,
      tarihToleransGun: opt.dateToleranceDays,
    },
    ozet: {
      eslesen: pairs.length,
      saatiFarkli: differentPairs.length,
      saatiAyni: pairs.length - differentPairs.length,
      [`sadece_${nameA}`]: onlyA.length,
      [`sadece_${nameB}`]: onlyB.length,
    },
    farkliMaclar: opt.flat ? rows : groupRows(rows, nameA),
  };

  if (opt.includeUnmatched) {
    const slim = (m) => ({
      sport: m.sport,
      league: m.league,
      date: m.date,
      time: m.time,
      home: m.home,
      away: m.away,
      eventId: m.eventId,
    });
    result.eslesmeyenler = {
      [nameA]: onlyA.map(slim),
      [nameB]: onlyB.map(slim),
    };
  }

  return result;
}

/* =========================================================================
 * 7) KOMUT SATIRI
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

Kullanım:
  node mac-saati-karsilastir.js <dosya1.json> <dosya2.json> [seçenekler]

Seçenekler:
  -o, --out <dosya>       Sonucu dosyaya yaz (varsayılan: ekrana bas)
      --ozet              JSON yerine kısa özet tablo göster
      --tolerans <dk>     Bu kadar veya daha az farkı "aynı" say (varsayılan: 0)
      --takim-esigi <n>   Takım adı benzerlik eşiği 0-100 (varsayılan: ${DEFAULTS.teamThreshold})
      --lig-esigi <n>     Lig adı benzerlik eşiği 0-100 (varsayılan: ${DEFAULTS.leagueThreshold})
      --lig-zorunlu       Lig eşleşmesini zorunlu kıl (varsayılan: sadece ağırlık)
      --tarih-tolerans <g> Gün toleransı (varsayılan: ${DEFAULTS.dateToleranceDays}, gece yarısı kaymaları için)
      --eslesmeyenler     Çıktıya eşleşmeyen maçları da ekle
      --duz               Gruplamadan düz liste üret
  -h, --help              Bu yardım

Girdi dosyaları betist-match-fetcher.js ve mavibet-match-fetcher.js
çıktılarıdır (ikisi de aynı yapıda). Sıra önemli değildir; site adları
dosya adlarından türetilir.
`);
}

function printSummary(result) {
  const [nameA, nameB] = Object.keys(result.kaynaklar);
  console.log("");
  for (const [name, src] of Object.entries(result.kaynaklar)) {
    console.log(`  ${name.padEnd(12)} ${src.macSayisi} maç   (${src.dosya})`);
  }
  console.log("");
  console.log(`  Eşleşen maç      : ${result.ozet.eslesen}`);
  console.log(`  SAATİ FARKLI     : ${result.ozet.saatiFarkli}`);
  console.log(`  Saati aynı       : ${result.ozet.saatiAyni}`);
  console.log(
    `  Sadece ${nameA.padEnd(10)}: ${result.ozet[`sadece_${nameA}`]}`
  );
  console.log(
    `  Sadece ${nameB.padEnd(10)}: ${result.ozet[`sadece_${nameB}`]}`
  );
  console.log("");

  const tree = result.farkliMaclar;
  if (Array.isArray(tree)) {
    for (const r of tree)
      console.log(
        `  ${r.sport} | ${r.league} | ${r.date} | ${r.home} - ${r.away} | ${r.fark}`
      );
    return;
  }

  for (const [sport, leagues] of Object.entries(tree)) {
    console.log(`${sport}`);
    for (const [league, dates] of Object.entries(leagues)) {
      console.log(`  ${league}`);
      for (const [date, rows] of Object.entries(dates)) {
        for (const r of rows) {
          const a = r[nameA],
            b = r[nameB];
          console.log(`    ${date}  ${r.home} - ${r.away}`);
          console.log(
            `        ${nameA}: ${a.date} ${a.time}   ${nameB}: ${b.date} ${b.time}   fark: ${r.fark}`
          );
        }
      }
    }
    console.log("");
  }
}

async function main() {
  const { files, options } = parseArgs(process.argv.slice(2));

  if (options.help || files.length < 2) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  const result = await compareFiles(files[0], files[1], options);

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

// Doğrudan çalıştırıldığında CLI; import edildiğinde sadece fonksiyonlar.
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main().catch((error) => {
    console.error("Hata:", error.message);
    process.exitCode = 1;
  });
}
