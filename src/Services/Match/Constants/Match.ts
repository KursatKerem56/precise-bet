/**
 * Uygulama ici normalized spor degerleri.
 *
 * Bu liste, fetcher katalogundaki (Fetchers/Sports/catalog.js) `id`
 * alanlariyla BIREBIR ayni olmak zorundadir; katalog tek kaynak, burasi
 * onun TypeScript tarafindaki yansimasi. Uyumu `catalog.test.js` dogruluyor.
 *
 * Ilk dort deger eski surumden degismedi (veritabaninda kayitli maclar
 * bunlari kullaniyor).
 */
enum EMatchSport {
  FOOTBALL = "FOOTBALL",
  BASKETBALL = "BASKETBALL",
  VOLLEYBALL = "VOLLEYBALL",
  TENNIS = "TENNIS",

  TABLE_TENNIS = "TABLE_TENNIS",
  ICE_HOCKEY = "ICE_HOCKEY",
  AMERICAN_FOOTBALL = "AMERICAN_FOOTBALL",
  BASEBALL = "BASEBALL",
  HANDBALL = "HANDBALL",
  RUGBY = "RUGBY",
  CRICKET = "CRICKET",
  MMA = "MMA",
  BOXING = "BOXING",
  FORMULA_1 = "FORMULA_1",
  MOTORSPORT = "MOTORSPORT",
  FUTSAL = "FUTSAL",
  WATER_POLO = "WATER_POLO",
  DARTS = "DARTS",
  SNOOKER = "SNOOKER",
  GOLF = "GOLF",
  CHESS = "CHESS",
  CYCLING = "CYCLING",
  BIATHLON = "BIATHLON",
  SKIING = "SKIING",
  AUSTRALIAN_FOOTBALL = "AUSTRALIAN_FOOTBALL",
  FLOORBALL = "FLOORBALL",
  GAELIC_FOOTBALL = "GAELIC_FOOTBALL",
  HURLING = "HURLING",
  BANDY = "BANDY",
  SAILING = "SAILING",
  SURFING = "SURFING",
  KABADDI = "KABADDI",
  SUMO = "SUMO",
  FIELD_HOCKEY = "FIELD_HOCKEY",
}

export { EMatchSport };
