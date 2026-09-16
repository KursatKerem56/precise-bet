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
        const ia = bySite[siteA].indexOf(pair.a);
        const ib = bySite[siteB].indexOf(pair.b);
        if (ia < 0 || ib < 0) continue;

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
const SPORT_ORDER = ["FUTBOL", "BASKETBOL", "VOLEYBOL", "TENIS"];
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

  return {
    sport: first.sport,
    league: first.league,
    date: first.date,
    home: first.home,
    away: first.away,
    saatler,
    tarihler,
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

  const siteNames = uniqueSiteNames(filePaths);

  const bySite = {};
  const kaynaklar = {};

  for (let i = 0; i < filePaths.length; i++) {
    const raw = JSON.parse(await readFile(filePaths[i], "utf8"));
    const parsed = normalizeInput(raw, filePaths[i], opt);

    const site = siteNames[i];
    bySite[site] = parsed.matches.map((m) => ({ ...m, site }));
    kaynaklar[site] = { dosya: filePaths[i], macSayisi: bySite[site].length };
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

async function main() {
  const { files, options } = parseArgs(process.argv.slice(2));

  if (options.help || files.length < 2) {
    printHelp();
    process.exit(options.help ? 0 : 1);
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
