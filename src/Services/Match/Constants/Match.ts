/**
 * The normalised in-app sport values.
 *
 * This list must be EXACTLY the same as the `id` fields in the fetcher
 * catalog (Fetchers/Sports/catalog.js); the catalog is the single source and
 * this is its TypeScript side reflection. `catalog.test.js` verifies they
 * agree.
 *
 * The first four values are unchanged from the old version (the matches
 * stored in the database use them).
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
