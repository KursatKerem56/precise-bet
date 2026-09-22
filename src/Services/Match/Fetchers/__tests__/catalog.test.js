/**
 * Spor katalogu testleri.
 *
 * Buradaki alias'lar UYDURMA DEGIL: uc siteden canli olarak okunan gercek
 * spor adlari. Bir site adlandirmasini degistirirse bu testler kirilir ve
 * sessizce "spor kayboldu" durumuna dusmeyiz.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SPORTS,
  SPORT_ORDER,
  LEGACY_KEYS,
  resolveSport,
  getSportByKey,
  resolveEnabledSportKeys,
} from "../Sports/catalog.js";

test("katalog anahtarlari ve id'leri benzersiz", () => {
  const keys = SPORTS.map((s) => s.key);
  const ids = SPORTS.map((s) => s.id);

  assert.equal(new Set(keys).size, keys.length, "tekrarlayan key var");
  assert.equal(new Set(ids).size, ids.length, "tekrarlayan id var");
});

test("eski dort spor ilk sirada ve anahtarlari degismemis", () => {
  assert.deepEqual(SPORT_ORDER.slice(0, 4), LEGACY_KEYS);

  assert.equal(getSportByKey("FUTBOL").id, "FOOTBALL");
  assert.equal(getSportByKey("BASKETBOL").id, "BASKETBALL");
  assert.equal(getSportByKey("VOLEYBOL").id, "VOLLEYBALL");
  assert.equal(getSportByKey("TENIS").id, "TENNIS");
});

test("betist'in gercek menu adlari cozuluyor", () => {
  const cases = {
    Futbol: "FUTBOL",
    Basketbol: "BASKETBOL",
    Voleybol: "VOLEYBOL",
    Tenis: "TENIS",
    "Buz Hokeyi": "BUZ_HOKEYI",
    "Amerikan Futbolu": "AMERIKAN_FUTBOLU",
    Beyzbol: "BEYZBOL",
    Hentbol: "HENTBOL",
    "Salon Futbolu": "SALON_FUTBOLU",
    Kriket: "KRIKET",
    Boks: "BOKS",
    "Formula 1": "FORMULA_1",
    Sutopu: "SUTOPU",
    Ragbi: "RAGBI",
    Rugby: "RAGBI",
    "Avustralya Futbolu": "AVUSTRALYA_FUTBOLU",
    Santranç: "SATRANC",
    Dart: "DART",
    "Araba Yarışları": "MOTOR_SPORLARI",
  };

  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(resolveSport(name)?.key, expected, `betist: ${name}`);
  }
});

test("virusbet'in camelCase alias'lari cozuluyor", () => {
  const cases = {
    Soccer: "FUTBOL",
    Basketball: "BASKETBOL",
    Volleyball: "VOLEYBOL",
    Tennis: "TENIS",
    IceHockey: "BUZ_HOKEYI",
    AmericanFootball: "AMERIKAN_FUTBOLU",
    TableTennis: "MASA_TENISI",
    RugbyUnion: "RAGBI",
    RugbyLeague: "RAGBI",
    WaterPolo: "SUTOPU",
    AustralianFootball: "AVUSTRALYA_FUTBOLU",
    GaelicFootball: "GAELIC_FUTBOLU",
    Mma: "MMA",
    Formula1: "FORMULA_1",
    AutoRacing: "MOTOR_SPORLARI",
    Nascar: "MOTOR_SPORLARI",
    BallHockey: "BANDY",
    CrossCountrySkiing: "KAYAK",
    AlpineSkiing: "KAYAK",
  };

  for (const [alias, expected] of Object.entries(cases)) {
    assert.equal(resolveSport(alias)?.key, expected, `virusbet: ${alias}`);
  }
});

test("mavibet'in kisaltilmis adlari cozuluyor", () => {
  const cases = {
    Football: "FUTBOL",
    "Table Tennis": "MASA_TENISI",
    // mavibet American Football'u boyle kisaltiyor.
    "Am. Football": "AMERIKAN_FUTBOLU",
    "Ice Hockey": "BUZ_HOKEYI",
    "Aussie Rules": "AVUSTRALYA_FUTBOLU",
    "Rugby Union": "RAGBI",
    "Motor Racing": "MOTOR_SPORLARI",
    "Gaelic Football": "GAELIC_FUTBOLU",
    Futsal: "SALON_FUTBOLU",
    Bandy: "BANDY",
    Kabaddi: "KABADDI",
  };

  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(resolveSport(name)?.key, expected, `mavibet: ${name}`);
  }
});

test("taninmayan spor null doner (uydurmaz)", () => {
  // Bu sporlar gercekten sitelerde var ama katalogda yok; sessizce yanlis
  // bir anahtara duserlerse siteler arasi karsilastirma bozulur.
  for (const name of [
    "Counter-Strike 2",
    "League of Legends",
    "Politics",
    "TV Shows and Movies",
    "Virtual Sports",
    "",
    null,
    undefined,
  ]) {
    assert.equal(resolveSport(name), null, `beklenmedik eslesme: ${name}`);
  }
});

test("katalog id'leri ve anahtarlari SCREAMING_SNAKE_CASE", () => {
  for (const sport of SPORTS) {
    assert.match(sport.id, /^[A-Z][A-Z0-9_]*$/, `bozuk id: ${sport.id}`);
    assert.match(sport.key, /^[A-Z][A-Z0-9_]*$/, `bozuk key: ${sport.key}`);
  }
});

test("katalog ile EMatchSport enum'u birebir ortusuyor", () => {
  // Katalog (JS) ile enum (TS) iki ayri dosyada yasiyor. Biri guncellenip
  // digeri unutulursa Match.service.ts o sporu kaydedemez ve mac sessizce
  // veritabanina yazilmaz. Bu testin amaci tam olarak o sapmayi yakalamak.
  //
  // node:test .ts import edemedigi icin enum METIN olarak okunuyor.
  const source = readFileSync(
    new URL("../../Constants/Match.ts", import.meta.url),
    "utf8"
  );

  const enumValues = [...source.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/gm)];

  assert.ok(enumValues.length > 4, "enum okunamadi");

  for (const [, name, value] of enumValues) {
    assert.equal(name, value, `EMatchSport.${name} degeri adiyla ayni olmali`);
  }

  const inEnum = new Set(enumValues.map(([, name]) => name));
  const inCatalog = new Set(SPORTS.map((s) => s.id));

  const missingInEnum = [...inCatalog].filter((id) => !inEnum.has(id));
  const missingInCatalog = [...inEnum].filter((id) => !inCatalog.has(id));

  assert.deepEqual(missingInEnum, [], "EMatchSport'a eklenmemis katalog id'leri");
  assert.deepEqual(missingInCatalog, [], "katalogda karsiligi olmayan enum degerleri");
});

test("MATCH_SPORTS hem key hem id kabul ediyor", () => {
  assert.equal(resolveEnabledSportKeys(""), null, "bos = kisitlama yok");
  assert.equal(resolveEnabledSportKeys(undefined), null);

  const bySport = resolveEnabledSportKeys("FUTBOL,BASKETBOL");
  assert.deepEqual([...bySport].sort(), ["BASKETBOL", "FUTBOL"]);

  // Ingilizce id'ler de calismali.
  const byId = resolveEnabledSportKeys("FOOTBALL, TABLE_TENNIS");
  assert.deepEqual([...byId].sort(), ["FUTBOL", "MASA_TENISI"]);

  // Tamamen taninmayan girdi kisitlama uygulamamali (her seyi elemektense).
  assert.equal(resolveEnabledSportKeys("zzz,qqq"), null);
});
