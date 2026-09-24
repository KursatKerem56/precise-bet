/**
 * MERKEZI ESLESTIRME AYARLARI
 *
 * Esik degerleri eskiden compare-match-times.js icine dagilmisti ve bir
 * kismi (lowLeagueScore, teamScoreWhenLeagueLow) DEFAULTS'ta hic tanimli
 * degildi -- yani o guvenlik kontrolu sessizce hic calismiyordu. Artik
 * butun sayilar tek yerde.
 *
 * Degerler gercek veriye bakilarak secildi; secim gerekcesi her birinin
 * yaninda yazili.
 */

export const MATCH_CONFIG = {
  /* --- Takim --------------------------------------------------------- */

  /** Iki adin "ayni takim" sayilmasi icin gereken bulanik skor (0-100).
   * 78: uc sitenin gercek verisinde dogru eslesmelerin en dusugu ~82
   * (Namibya/Namibia), yanlis eslesmelerin en yuksegi ~73 (Manchester City/
   * Leicester City). 78 iki kumenin tam ortasinda duruyor. */
  teamThreshold: 78,

  /** Alias uzerinden ayni kanonik takima cozulen adlarin skoru. Bulanik
   * eslesmeden HER ZAMAN daha guvenilir kabul edilir. */
  teamAliasScore: 100,

  /** "Sadece zayif kelime ortak" korumasinin esigi.
   *
   * Bu bir ESLESTIRME esigi degil, TESADUF korumasidir; bu yuzden ana
   * esikten daha dusuk. Zayif kelime disindaki cekirdek adlar bu kadar
   * bile benzemiyorsa ortaklik tesadufidir:
   *   "Manchester" / "Leicester" -> 50  (reddedilir, dogru)
   *   "Salfrod"    / "Salford"   -> 71  (kabul edilir: yazim hatasi) */
  weakOverlapCoreThreshold: 65,

  /* --- Lig ----------------------------------------------------------- */

  /** Lig adi "ayni" sayilsin diye gereken bulanik skor. */
  leagueThreshold: 55,

  /** Lig eslesmesi zorunlu mu? Varsayilan hayir: uc site lig adlarini cok
   * farkli yaziyor ("International Clubs - UEFA Champions League" vs
   * "Europe - UEFA Champions League - League Stage"), zorunlu tutmak
   * gercek eslesmelerin buyuk kismini kaybettirir. */
  requireLeague: false,

  /** Lig adlari birbirinden tamamen farkliysa takim skorunun bu esigi
   * asmasi beklenir. (Eskiden tanimsizdi -> kontrol hic calismiyordu.) */
  lowLeagueScore: 35,
  teamScoreWhenLeagueLow: 88,

  /* --- Tarih / saat --------------------------------------------------- */

  /** Gece yarisini asan kaymalari yakalamak icin +-1 gun komsuluguna bakilir. */
  dateToleranceDays: 1,

  /** Bu kadar veya daha az fark "ayni saat" sayilir. */
  toleranceMinutes: 0,

  /** KOMSU GUNDEKI adaylar icin ust sinir (dakika).
   *
   * 2160 dk = 36 saat. Bu bir AKIL SAGLIGI siniridir, gece yarisi
   * toleransi degil: ayni iki takim komsu gunlerde tekrar karsilasmadigi
   * icin (futbol/boks/MMA/tenis) komsu gunde eslesen kayitlar gercekte
   * AYNI macin TARIHI FARKLI yazilmis halidir ve bu bilgi kullanici icin
   * en az saat farki kadar degerlidir.
   *
   * Bu yuzden komsu gun adaylari ELENMEZ; bunun yerine:
   *   - siralamada ayni gun adaylari her zaman one gecer (crossDatePenalty)
   *   - cikti bunlari `tarihFarkli` olarak AYRICA isaretler
   * boylece 1380 dk gibi yaniltici bir "saat farki" tek basina
   * raporlanmaz. */
  maxAdjacentDayDiffMinutes: 2160,

  /** Ayni gun adayini komsu gun adayinin ONUNE gecirmek icin siralama
   * cezasi. Ayni takimlarin hem bugun hem yarin kaydi varsa dogru olan
   * ayni gun eslesmesidir. */
  crossDatePenalty: 500,

  /* --- Aday daraltma (blocking) --------------------------------------- */

  /** Takim adi token'larindan uretilen blocking anahtarinin uzunlugu.
   * 3 harf: gercek veride 2068 dogru eslesmenin 2067'sini koruyor
   * (%99.95) ve aday sayisini %4.4'e dusuruyor. */
  blockingPrefixLength: 3,

  /* --- Guven seviyeleri ----------------------------------------------- */

  /** Bunun ustu "match", altindaki bant "possible_match". */
  highConfidence: 0.92,
  possibleConfidence: 0.75,

  /* --- Teshis --------------------------------------------------------- */

  /** Alias veritabaninda bulunamayan lig/takim adlarini topla.
   * Production'da log kalabaligi yapmamasi icin varsayilan kapali;
   * MATCH_DEBUG_UNRESOLVED=1 ile acilir. */
  collectUnresolved: process.env.MATCH_DEBUG_UNRESOLVED === "1",

  /** Oneri ciktisina bir ad icin en fazla kac aday yazilsin. */
  maxSuggestionsPerName: 3,

  /** Oneri sayilmak icin gereken en dusuk bulanik skor. */
  suggestionThreshold: 80,
};

/**
 * TAKIM NITELEYICILERI
 *
 * "Athletic Bilbao" ile "Athletic Bilbao B" AYNI TAKIM DEGILDIR. Bu ekler
 * karakter benzerligini cok az degistirdigi icin bulanik eslestirme tek
 * basina ayirt edemiyor; bu yuzden isimden AYRI cikarilip ayrica
 * karsilastiriliyor: biri varsa digerinde de olmak ZORUNDA.
 */
export const TEAM_QUALIFIERS = new Set([
  "ii",
  "iii",
  "u16",
  "u17",
  "u18",
  "u19",
  "u20",
  "u21",
  "u23",
  "res",
  "reserve",
  "reserves",
  "rezerv",
  "castilla",
  "atletic",
  "youth",
  "junior",
  "juniors",
  "jr",
  "genclik",
  "altyapi",
  "amateur",
  "amator",
  "women",
  "womens",
  "wom",
  "kadin",
  "kadinlar",
  "femenino",
  "feminin",
  "feminine",
  "fem",
  "ladies",
  "academy",
  "akademi",
]);

/**
 * LIG NITELEYICILERI
 *
 * Ayni ulkenin erkek/kadin/genclik ligleri ayri yarismalardir:
 * "Argentina - Primera Division" ile "Argentina - Primera Division, Women"
 * ayni lig degildir. Bu niteleyiciler iki tarafta da ayni olmali.
 */
export const LEAGUE_QUALIFIERS = new Set([
  "u16",
  "u17",
  "u18",
  "u19",
  "u20",
  "u21",
  "u23",
  "women",
  "womens",
  "wom",
  "kadin",
  "kadinlar",
  "ladies",
  "femenino",
  "feminin",
  "feminine",
  "fem",
  "youth",
  "junior",
  "juniors",
  "juvenil",
  "genclik",
  "reserve",
  "reserves",
  "rezerv",
  "amateur",
  "amator",
]);

/**
 * Lig duzeyinde niteleyiciler KABA SINIFA indirgenir.
 *
 * Bir site "U19, Youth League" derken digeri "Division de Honor Juvenil"
 * diyor: ikisi de genclik ligi, ama biri yas grubunu, digeri sadece
 * "juvenil" diyor. Lig duzeyinde onemli olan KATEGORI (genclik / kadinlar
 * / rezerv); kesin yas grubu zaten TAKIM adinda ayrica kontrol ediliyor.
 */
export const LEAGUE_QUALIFIER_CLASS = new Map(
  Object.entries({
    u16: "youth",
    u17: "youth",
    u18: "youth",
    u19: "youth",
    u20: "youth",
    u21: "youth",
    u23: "youth",
    youth: "youth",
    junior: "youth",
    juniors: "youth",
    juvenil: "youth",
    genclik: "youth",
    women: "women",
    womens: "women",
    wom: "women",
    kadin: "women",
    kadinlar: "women",
    ladies: "women",
    femenino: "women",
    feminin: "women",
    feminine: "women",
    fem: "women",
    reserve: "reserve",
    reserves: "reserve",
    rezerv: "reserve",
    amateur: "amateur",
    amator: "amateur",
  })
);

/**
 * Tek baslarina GUCLU KIMLIK TASIMAYAN kelimeler.
 *
 * "Manchester City" ile "Leicester City" sadece "City" ortak diye
 * eslesmemeli. Bu kelimeler blocking anahtari uretmez ve token ortusmesinde
 * dusuk agirlikla sayilir.
 */
export const WEAK_TOKENS = new Set([
  "united",
  "utd",
  "city",
  "sporting",
  "racing",
  "real",
  "athletic",
  "atletico",
  "club",
  "deportivo",
  "deportes",
  "sportif",
  "sport",
  "sports",
  "de",
  "del",
  "la",
  "le",
  "el",
  "al",
  "las",
  "los",
  "os",
  "as",
  "the",
  "and",
  "y",
  "e",
  "di",
  "da",
  "do",
  "dos",
  "van",
  "von",
]);

/**
 * Kulup turu belirten jenerik ekler. Ad karsilastirmasinda atilir.
 * Bilincli olarak kisa tutuldu; agresif temizlik yanlis eslesme uretir.
 */
export const GENERIC_TOKENS = new Set([
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
  "ss",
  "ca",
  "ce",
  "ec",
  "aa",
  "cr",
  "afc",
  "cfc",
  "hc",
  "hk",
  "kh",
  "mhc",
  "mhk",
  "jk",
  "us",
  "ssd",
  "asd",
  "nk",
  "rk",
  // "as": AS Monaco / Monaco, AS Cannes / Cannes -- gercek veride uc
  // sitenin de bir kismi bu oneki yaziyor, bir kismi yazmiyor.
  "as",
  "cs",
  "cp",
  "sv",
  "rc",
  "cda",
  "club",
  // Slav hokey/futbol kulup onekleri: HC/HK/KH/MHK ailesinin devami.
  "skp",
  "ohk",
  "mhc",
  "shk",
  "bc",
  "kk",
  "rk",
  "dvsc",
]);

/**
 * Yalnizca BELLI SPORLARDA jenerik sayilan ekler.
 *
 * "Rugby" ragbi kulubu adinda tur belirtir ("Montpellier Herault Rugby" /
 * "Montpellier Herault RC") ama futbolda ayirt edici olabilir.
 */
export const SPORT_GENERIC_TOKENS = new Map([
  ["RAGBI", new Set(["rugby", "rc"])],
  ["BUZ_HOKEYI", new Set(["hokej", "hockey"])],
  ["BASKETBOL", new Set(["basket", "basketball", "bc"])],
]);

/** ABD liglerinde sehir kisaltmasi acilabilecek sporlar.
 * "La Plata" -> "Los Angeles Plata" felaketini onlemek icin sehir
 * kisaltmalari YALNIZCA bu sporlarda uygulanir. */
/**
 * BIREYSEL sporlar.
 *
 * Lig niteleyicisi kontrolu (Women / U21 / Reserve) KULUP sporlari icin
 * var: ayni kulubun erkek, kadin ve U19 takimi AYNI ADI tasir, ayirt
 * edici tek sey ligin niteleyicisidir.
 *
 * Bireysel sporlarda boyle bir risk yok -- sporcu adi zaten tekil. Buna
 * karsilik turnuva adlandirmasi cok tutarsiz ("ITF W15 Constanta" vs
 * "WTT Women - Constanta - Clay"), bu yuzden kontrolu bu sporlarda
 * uygulamak yalnizca dogru eslesmeleri eliyordu.
 */
export const INDIVIDUAL_SPORTS = new Set([
  "TENIS",
  "MASA_TENISI",
  "BOKS",
  "MMA",
  "SATRANC",
  "DART",
  "SNOOKER",
  "GOLF",
  "BISIKLET",
  "SUMO",
  "KAYAK",
  "BIATLON",
]);

export const US_LEAGUE_SPORTS = new Set([
  "BASKETBOL",
  "AMERIKAN_FUTBOLU",
  "BEYZBOL",
  "BUZ_HOKEYI",
]);
