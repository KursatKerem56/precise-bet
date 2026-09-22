/**
 * MERKEZI SPOR KATALOGU
 *
 * Eskiden spor bilgisi bes ayri yerde, birbirinden habersiz duruyordu:
 *   - betist    : canonicalSportName() + TARGET_ORDER
 *   - virusbet  : SPORTS[] (sportId sabitleri) + TARGET_ORDER
 *   - mavibet   : SPORTS[] (sportId + tree sabitleri) + TARGET_ORDER
 *   - compare-match-times.js : SPORT_CANON + SPORT_ORDER
 *   - Match.service.ts       : ic ice ternary
 *
 * Yeni bir spor eklemek bu bes yeri birden degistirmeyi gerektiriyordu ve
 * Match.service.ts'teki ternary bilinmeyen her sporu sessizce TENNIS'e
 * yaziyordu.
 *
 * Artik tek kaynak burasi. Bir spor eklemek = asagiya bir satir eklemek.
 *
 * ---------------------------------------------------------------------------
 * SITE ID'LERI NEDEN BURADA YOK
 *
 * Ucu de spor id'sini ZATEN cektikleri veriden bildiriyor:
 *   betist   -> home.php menusunde  (check__{id} + sport-name)
 *   virusbet -> swarm sport agacinda (id + alias + name)
 *   mavibet  -> disciplinesV2 dump'inda (id + name)
 *
 * Yani id'leri sabit yazmak gereksiz ve kirilgan olurdu (site id degistirince
 * sessizce yanlis spor cekilir). Bunun yerine site ADI bildiriyor, biz
 * `aliases` uzerinden normalize ediyoruz. Id sabiti YOK.
 *
 * `key`  -> JSON ciktisindaki ust duzey anahtar (geriye donuk uyumluluk)
 * `id`   -> uygulama ici normalized deger (EMatchSport ile ayni)
 */

import { foldName } from "../Core/text.js";

/**
 * Not: LEGACY_KEYS'teki dort spor cikti JSON'unda HER ZAMAN bulunur (bos
 * olsa bile), cunku mevcut tuketiciler bu dort anahtarin varligina guveniyor.
 */
const LEGACY_KEYS = ["FUTBOL", "BASKETBOL", "VOLEYBOL", "TENIS"];

/**
 * @type {Array<{ key: string, id: string, aliases: string[] }>}
 *
 * Siralama onemli: cikti ve raporlar bu sirayi kullanir. Ilk dort, eski
 * TARGET_ORDER ile birebir ayni.
 */
const SPORTS = [
  { key: "FUTBOL", id: "FOOTBALL", aliases: ["futbol", "soccer", "football"] },
  { key: "BASKETBOL", id: "BASKETBALL", aliases: ["basketbol", "basketball"] },
  { key: "VOLEYBOL", id: "VOLLEYBALL", aliases: ["voleybol", "volleyball"] },
  { key: "TENIS", id: "TENNIS", aliases: ["tenis", "tennis"] },

  {
    key: "MASA_TENISI",
    id: "TABLE_TENNIS",
    aliases: ["masa tenisi", "table tennis"],
  },
  {
    key: "BUZ_HOKEYI",
    id: "ICE_HOCKEY",
    aliases: ["buz hokeyi", "ice hockey"],
  },
  {
    key: "AMERIKAN_FUTBOLU",
    id: "AMERICAN_FOOTBALL",
    // mavibet bunu "Am. Football" diye kisaltiyor.
    aliases: ["amerikan futbolu", "american football", "am football"],
  },
  { key: "BEYZBOL", id: "BASEBALL", aliases: ["beyzbol", "baseball"] },
  { key: "HENTBOL", id: "HANDBALL", aliases: ["hentbol", "handball"] },
  {
    key: "RAGBI",
    id: "RUGBY",
    // Union/League ayrimi kasitli olarak TEK anahtarda birlestirildi: betist
    // "Rugby"/"Ragbi" derken virusbet ve mavibet "Rugby Union"/"Rugby League"
    // diyor. Ayirsaydik ayni mac siteler arasinda hic eslesemezdi.
    aliases: ["rugby", "ragbi", "rugby union", "rugby league"],
  },
  { key: "KRIKET", id: "CRICKET", aliases: ["kriket", "cricket"] },
  { key: "MMA", id: "MMA", aliases: ["mma", "mixed martial arts"] },
  { key: "BOKS", id: "BOXING", aliases: ["boks", "boxing"] },
  {
    key: "FORMULA_1",
    id: "FORMULA_1",
    aliases: ["formula 1", "formula one", "f1"],
  },
  {
    key: "MOTOR_SPORLARI",
    id: "MOTORSPORT",
    aliases: [
      "araba yarislari",
      "auto racing",
      "motor racing",
      "motorsport",
      "nascar",
    ],
  },
  {
    key: "SALON_FUTBOLU",
    id: "FUTSAL",
    aliases: ["salon futbolu", "futsal"],
  },
  { key: "SUTOPU", id: "WATER_POLO", aliases: ["sutopu", "water polo"] },
  { key: "DART", id: "DARTS", aliases: ["dart", "darts"] },
  { key: "SNOOKER", id: "SNOOKER", aliases: ["snooker", "bilardo"] },
  { key: "GOLF", id: "GOLF", aliases: ["golf"] },
  { key: "SATRANC", id: "CHESS", aliases: ["santranc", "satranc", "chess"] },
  {
    key: "BISIKLET",
    id: "CYCLING",
    aliases: ["bisiklet yarisi", "bisiklet", "cycling"],
  },
  { key: "BIATLON", id: "BIATHLON", aliases: ["biatlon", "biathlon"] },
  {
    key: "KAYAK",
    id: "SKIING",
    aliases: [
      "kayak",
      "alpine skiing",
      "cross country skiing",
      "ski jumping",
      "skiing",
    ],
  },
  {
    key: "AVUSTRALYA_FUTBOLU",
    id: "AUSTRALIAN_FOOTBALL",
    aliases: ["avustralya futbolu", "australian football", "aussie rules"],
  },
  { key: "FLOORBALL", id: "FLOORBALL", aliases: ["floorball"] },
  {
    key: "GAELIC_FUTBOLU",
    id: "GAELIC_FOOTBALL",
    aliases: ["gaelic football"],
  },
  { key: "HURLING", id: "HURLING", aliases: ["hurling"] },
  { key: "BANDY", id: "BANDY", aliases: ["bandy", "ball hockey"] },
  {
    key: "YELKEN",
    id: "SAILING",
    aliases: ["yelkencilik", "sailing", "yachting"],
  },
  { key: "SORF", id: "SURFING", aliases: ["sorf", "surfing"] },
  { key: "KABADDI", id: "KABADDI", aliases: ["kabaddi"] },
  { key: "SUMO", id: "SUMO", aliases: ["sumo"] },
  {
    key: "HALI_HOKEYI",
    id: "FIELD_HOCKEY",
    aliases: ["field hockey", "hali hokeyi"],
  },
];

// --- Indeksler (modul yuklenirken bir kez kurulur) ---------------------------

/** foldName(alias) -> spor kaydi */
const byAlias = new Map();

/** key -> spor kaydi */
const byKey = new Map();

/** id -> spor kaydi */
const byId = new Map();

for (const sport of SPORTS) {
  byKey.set(sport.key, sport);
  byId.set(sport.id, sport);

  // Anahtarin ve id'nin kendisi de gecerli birer alias'tir; boylece
  // MATCH_SPORTS=FUTBOL ve MATCH_SPORTS=FOOTBALL ikisi de calisir.
  for (const alias of [...sport.aliases, sport.key, sport.id]) {
    byAlias.set(foldName(alias), sport);
  }
}

/** Ciktida ve raporlarda kullanilan sira. */
const SPORT_ORDER = SPORTS.map((sport) => sport.key);

/**
 * Sitenin bildirdigi spor adini katalog kaydina cevirir.
 * Tanimadigimiz bir spor icin `null` doner -- UYDURMAZ.
 *
 * @param {...(string|null|undefined)} names Denenecek adlar (ad, alias, kisa ad)
 */
function resolveSport(...names) {
  for (const name of names) {
    if (!name) continue;

    const found = byAlias.get(foldName(name));

    if (found) return found;
  }

  return null;
}

const getSportByKey = (key) => byKey.get(String(key)) ?? null;

const getSportById = (id) => byId.get(String(id)) ?? null;

/**
 * Cekilecek sporlari belirler.
 *
 * `MATCH_SPORTS` bos ise katalogdaki TUM sporlar hedeftir; sitede olmayan
 * spor zaten kesfedilmedigi icin bosuna istek atilmaz. Kisitlamak isteyen
 * ortam degiskeni verir, orn:
 *
 *     MATCH_SPORTS=FUTBOL,BASKETBOL,VOLEYBOL,TENIS   (eski davranis)
 *
 * @param {string} [raw]
 * @returns {Set<string>|null} izin verilen key kumesi; null = hepsi
 */
function resolveEnabledSportKeys(raw = process.env.MATCH_SPORTS) {
  const value = String(raw ?? "").trim();

  if (!value) return null;

  const keys = new Set();

  for (const part of value.split(/[,\s]+/).filter(Boolean)) {
    const sport = resolveSport(part);

    if (sport) keys.add(sport.key);
  }

  return keys.size ? keys : null;
}

export {
  SPORTS,
  SPORT_ORDER,
  LEGACY_KEYS,
  resolveSport,
  getSportByKey,
  getSportById,
  resolveEnabledSportKeys,
};
