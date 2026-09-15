/**
 * Mavibet HAR -> Maç çıkarıcı ve gruplayıcı (ES6 / ESM)
 *
 * HAR dosyasının içindeki WebSocket (WAMP) trafiğini okuyup maç kayıtlarını
 * çıkarır ve şu hiyerarşide gruplar:
 *
 *     SPOR  ->  LİG  ->  TARİH  ->  [maçlar]
 *
 * ---------------------------------------------------------------------------
 * HAR yapısı hakkında (bu dosya, gönderdiğiniz gerçek HAR'lar incelenerek
 * yazıldı):
 *
 *  - Maç verisi normal HTTP yanıtlarında DEĞİL, WebSocket mesajlarının içinde:
 *        har.log.entries[].\_webSocketMessages[]
 *    Chrome bu alanı "_webSocketMessages" adıyla yazıyor; bazı araçlar
 *    "webSocketMessages" kullandığı için ikisi de destekleniyor.
 *
 *  - Her mesaj bir WAMP çerçevesi (JSON dizi). Maç kayıtları RESULT (tip 50)
 *    mesajlarının kwargs'ında geliyor:
 *        [50, requestId, {}, [], { records: [ ... ] }]
 *    Sunucu push'ları ise INVOCATION (tip 68) ile geliyor:
 *        [68, ..., ..., {}, [], { messageType: "UPDATE", records: [...] }]
 *    Bu yüzden mesajın içinde "records" dizisi NEREDE olursa olsun bulan
 *    genel (derinlemesine) bir tarayıcı kullanıyoruz - WAMP çerçeve
 *    biçimi değişse bile kod çalışmaya devam eder.
 *
 *  - İlgilendiğimiz kayıtlar: `_type === "MATCH"`. Bir MATCH kaydı tek
 *    başına ihtiyacımız olan her şeyi taşıyor:
 *        sportId / sportName            -> SPOR
 *        parentId / parentName          -> LİG (shortParentName sezonsuz hali)
 *        venueName / categoryName       -> ÜLKE
 *        startTime (epoch ms, UTC)      -> TARİH + SAAT
 *        homeParticipantName / awayParticipantName
 *
 *  - UPDATE mesajları (`changeType: "UPDATE"`, `entityType: "MATCH"`) bir
 *    maçın alanlarını sonradan değiştirebiliyor (incelediğim HAR'da sadece
 *    numberOfMarkets değişiyordu, ama startTime da değişebilir). Bu yüzden
 *    güncellemeler, ilgili maça sırayla uygulanıyor - böylece sonuçta
 *    HAR'ın SONUNDAKİ en güncel değer kullanılmış oluyor.
 *
 *  - Saatler epoch ms (UTC) olarak geliyor; ekranda görünen saat Türkiye
 *    saati olduğu için tarih/saat alanları Europe/Istanbul'a çevriliyor.
 */

import { readFile } from "node:fs/promises";

export const DEFAULT_TIMEZONE = "Europe/Istanbul";

/* -------------------------------------------------------------------------
 * 1) HAR -> ham WAMP mesajları
 * ---------------------------------------------------------------------- */

/** Bir HAR nesnesindeki tüm WebSocket mesajlarını (her iki olası alan
 * adından da) tek bir düz diziye toplar. */
export function collectWebSocketMessages(har) {
  const entries = har?.log?.entries ?? [];
  const messages = [];

  for (const entry of entries) {
    const list = entry._webSocketMessages ?? entry.webSocketMessages ?? [];
    for (const message of list) {
      messages.push(message);
    }
  }

  return messages;
}

/** Bir WebSocket mesajının gövdesini JSON olarak çözer.
 * Metin (opcode 1) mesajlar doğrudan; ikili (opcode 2) mesajlar base64
 * kabul edilip önce çözülür. Parse edilemeyen mesajlar `null` döner. */
function parseMessageData(message) {
  const raw = message?.data;
  if (typeof raw !== "string" || raw.length === 0) return null;

  let text = raw;
  if (message.opcode === 2) {
    try {
      text = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    // WAMP dışı / bölünmüş çerçeveler olabilir - sessizce atla
    return null;
  }
}

/* -------------------------------------------------------------------------
 * 2) Mesajlar -> kayıt (record) akışı
 * ---------------------------------------------------------------------- */

/** Çözülmüş bir mesajın içinde, hangi derinlikte olursa olsun, tüm
 * `records` dizilerini bulur. WAMP çerçevesinde kwargs'ın indeksi mesaj
 * tipine göre değiştiği için (RESULT'ta 4, INVOCATION'da 5) sabit indeks
 * yerine bu genel tarama tercih edildi. */
function* iterateRecordArrays(node, depth = 0) {
  if (depth > 6 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) yield* iterateRecordArrays(item, depth + 1);
    return;
  }

  if (Array.isArray(node.records)) yield node.records;

  for (const value of Object.values(node)) {
    yield* iterateRecordArrays(value, depth + 1);
  }
}

/** HAR'daki tüm mesajları gezip sırayla (HAR'daki kronolojik sırayla)
 * her kaydı döndürür. */
export function* iterateRecords(har) {
  for (const message of collectWebSocketMessages(har)) {
    const parsed = parseMessageData(message);
    if (!parsed) continue;

    for (const records of iterateRecordArrays(parsed)) {
      for (const record of records) {
        if (record && typeof record === "object") yield record;
      }
    }
  }
}

/* -------------------------------------------------------------------------
 * 3) Tarih / saat biçimlendirme
 * ---------------------------------------------------------------------- */

const formatterCache = new Map();

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    );
  }
  return formatterCache.get(timeZone);
}

/** epoch ms -> { date: "2026-09-15", time: "20:00" } (verilen saat diliminde) */
export function formatInTimeZone(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const date = new Date(Number(epochMs));
  if (Number.isNaN(date.getTime())) return { date: null, time: null };

  const parts = getFormatter(timeZone).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/* -------------------------------------------------------------------------
 * 4) Maçları çıkar (+ UPDATE'leri uygula)
 * ---------------------------------------------------------------------- */

/** Bir MATCH kaydını sade bir maç nesnesine çevirir. */
function toMatch(record, timeZone) {
  const startTime = record.startTime != null ? Number(record.startTime) : null;
  const { date, time } = startTime != null ? formatInTimeZone(startTime, timeZone) : { date: null, time: null };

  return {
    eventId: record.id != null ? String(record.id) : null,

    sportId: record.sportId != null ? String(record.sportId) : null,
    sportName: record.sportName ?? null,

    leagueId: record.parentId != null ? String(record.parentId) : null,
    // parentName sezon bilgisiyle gelir ("Brezilya Serie A 2026"),
    // shortParentName ise sezonsuz kısa hali ("Brezilya Serie A").
    leagueName: record.parentName ?? null,
    leagueShortName: record.shortParentName ?? null,

    country: record.venueName ?? record.categoryName ?? null,

    home: record.homeParticipantName ?? null,
    away: record.awayParticipantName ?? null,
    name: record.name ?? null,

    date,
    time,
    startTime,
    startTimeIso: startTime != null ? new Date(startTime).toISOString() : null,

    status: record.statusName ?? null,
    numberOfMarkets: record.numberOfMarkets ?? null,
  };
}

/**
 * HAR'dan tüm maçları çıkarır.
 *
 * - Aynı maç birden fazla dump'ta geçebilir (ör. hem "popüler maçlar"
 *   hem de turnuva dökümünde) -> eventId bazında tekilleştirilir.
 * - UPDATE kayıtları (entityType === "MATCH") ilgili maça uygulanır,
 *   böylece HAR'ın sonundaki en güncel değerler kullanılır.
 *
 * @param {object} har  JSON.parse edilmiş HAR nesnesi
 * @param {{timeZone?: string}} [options]
 * @returns {Array} maç nesneleri dizisi
 */
export function extractMatches(har, { timeZone = DEFAULT_TIMEZONE } = {}) {
  /** @type {Map<string, object>} eventId -> ham MATCH kaydı */
  const rawById = new Map();

  for (const record of iterateRecords(har)) {
    // a) Tam kayıt (INITIAL_DUMP içinden)
    if (record._type === "MATCH" && record.id != null) {
      const id = String(record.id);
      // Aynı maç tekrar gelirse alanları birleştir (sonraki dump daha
      // fazla alan taşıyor olabilir).
      rawById.set(id, { ...(rawById.get(id) ?? {}), ...record });
      continue;
    }

    // b) Kısmi güncelleme (UPDATE push'u içinden)
    if (record.entityType === "MATCH" && record.id != null) {
      const id = String(record.id);
      const existing = rawById.get(id);
      // Daha önce görmediğimiz bir maçın sadece güncellemesi geldiyse,
      // elimizde takım/lig/saat bilgisi olmadığı için işe yaramaz - atla.
      if (!existing) continue;
      rawById.set(id, { ...existing, ...(record.changedProperties ?? {}) });
    }
  }

  return [...rawById.values()].map((record) => toMatch(record, timeZone));
}

/* -------------------------------------------------------------------------
 * 5) Gruplama: SPOR -> LİG -> TARİH
 * ---------------------------------------------------------------------- */

/** Bir Map'e, anahtar yoksa varsayılan değeri koyup döndürür. */
function getOrCreate(map, key, factory) {
  if (!map.has(key)) map.set(key, factory());
  return map.get(key);
}

const collator = new Intl.Collator("tr", { sensitivity: "base", numeric: true });

/**
 * Düz maç listesini SPOR -> LİG -> TARİH hiyerarşisinde gruplar.
 *
 * Sıralama: sporlar ada göre, ligler ada göre, tarihler artan (en yakın
 * tarih önce), maçlar saate göre.
 */
export function groupMatches(matches) {
  const sportsMap = new Map();

  for (const match of matches) {
    const sportKey = match.sportId ?? match.sportName ?? "bilinmeyen-spor";
    const sport = getOrCreate(sportsMap, sportKey, () => ({
      sportId: match.sportId,
      sportName: match.sportName ?? "Bilinmeyen",
      matchCount: 0,
      leaguesMap: new Map(),
    }));
    sport.matchCount += 1;

    const leagueKey = match.leagueId ?? match.leagueName ?? "bilinmeyen-lig";
    const league = getOrCreate(sport.leaguesMap, leagueKey, () => ({
      leagueId: match.leagueId,
      leagueName: match.leagueName ?? "Bilinmeyen",
      leagueShortName: match.leagueShortName ?? null,
      country: match.country ?? null,
      matchCount: 0,
      datesMap: new Map(),
    }));
    league.matchCount += 1;

    const dateKey = match.date ?? "bilinmeyen-tarih";
    const dateBucket = getOrCreate(league.datesMap, dateKey, () => ({
      date: match.date,
      matchCount: 0,
      matches: [],
    }));
    dateBucket.matchCount += 1;
    dateBucket.matches.push(match);
  }

  // Map'leri sıralı dizilere çevir
  const sports = [...sportsMap.values()]
    .map((sport) => ({
      sportId: sport.sportId,
      sportName: sport.sportName,
      matchCount: sport.matchCount,
      leagueCount: sport.leaguesMap.size,
      leagues: [...sport.leaguesMap.values()]
        .map((league) => ({
          leagueId: league.leagueId,
          leagueName: league.leagueName,
          leagueShortName: league.leagueShortName,
          country: league.country,
          matchCount: league.matchCount,
          dates: [...league.datesMap.values()]
            .map((bucket) => ({
              date: bucket.date,
              matchCount: bucket.matchCount,
              matches: bucket.matches.sort(
                (a, b) => (a.startTime ?? 0) - (b.startTime ?? 0)
              ),
            }))
            .sort((a, b) => String(a.date).localeCompare(String(b.date))),
        }))
        .sort((a, b) => collator.compare(a.leagueName, b.leagueName)),
    }))
    .sort((a, b) => collator.compare(a.sportName, b.sportName));

  return sports;
}

/* -------------------------------------------------------------------------
 * 6) Uçtan uca: HAR dosyaları -> tek JSON sonucu
 * ---------------------------------------------------------------------- */

/**
 * Bir veya daha fazla HAR dosyasını okuyup birleştirir ve gruplanmış
 * sonucu döndürür.
 *
 * @param {string[]} filePaths
 * @param {{timeZone?: string}} [options]
 */
export async function buildFromHarFiles(filePaths, { timeZone = DEFAULT_TIMEZONE } = {}) {
  const byId = new Map();
  const sources = [];

  for (const filePath of filePaths) {
    let har;
    try {
      har = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      sources.push({ file: filePath, ok: false, matchCount: 0, error: String(error.message ?? error) });
      continue;
    }

    const matches = extractMatches(har, { timeZone });
    for (const match of matches) {
      if (match.eventId) byId.set(match.eventId, match);
    }

    sources.push({
      file: filePath,
      ok: true,
      matchCount: matches.length,
      webSocketMessageCount: collectWebSocketMessages(har).length,
    });
  }

  const allMatches = [...byId.values()];
  const sports = groupMatches(allMatches);

  return {
    generatedAt: new Date().toISOString(),
    timeZone,
    sources,
    totals: {
      sports: sports.length,
      leagues: sports.reduce((sum, sport) => sum + sport.leagues.length, 0),
      matches: allMatches.length,
    },
    sports,
  };
}
