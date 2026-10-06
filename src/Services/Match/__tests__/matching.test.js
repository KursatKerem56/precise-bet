/**
 * ESLESTIRME TESTLERI
 *
 * Buradaki adlarin BUYUK KISMI UYDURMA DEGIL: uc siteden canli olarak
 * okunan gercek takim/lig adlari. Bir site adlandirmasini degistirirse ya
 * da bir normalize kurali gerilerse bu testler kirilir.
 *
 * Ozellikle YANLIS POZITIF testleri onemli: bunlar gecmiste gercekten
 * yasanmis hatalar (bkz. "HC Kosice" / "HK Poprad").
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  compareTeams,
  normalizeTeamName,
  resolveTeam,
} from "../Matching/team.js";
import {
  compareLeagues,
  resolveLeague,
  normalizeLeagueName,
} from "../Matching/league.js";
import {
  toEpochMs,
  dateKeyOffset,
  compareMatchTimes,
  calculateTimeDifference,
} from "../Matching/datetime.js";
import {
  buildMatchIndex,
  findMatchCandidates,
} from "../Matching/candidates.js";
import { compareMatches, MATCH_RESULT } from "../Matching/confidence.js";
import { similarityRatio } from "../Matching/similarity.js";
import { MATCH_CONFIG } from "../Matching/config.js";
import { buildLeagueIndex } from "../Matching/aliases.js";
import { canonicalSport } from "../compare-match-times.js";
import { resolveSport } from "../Fetchers/Sports/catalog.js";

buildLeagueIndex((name) => resolveSport(name)?.key ?? null);

const T = MATCH_CONFIG.teamThreshold;

/** Iki adin eslesip eslesmedigini soyler. */
const teamsMatch = (a, b, options) => compareTeams(a, b, options).score >= T;

/* =========================================================================
 * SPOR
 * ====================================================================== */

test("spor: Football / Soccer / futbol ayni kanonik spora coozuluyor", () => {
  assert.equal(canonicalSport("Football"), "FUTBOL");
  assert.equal(canonicalSport("Soccer"), "FUTBOL");
  assert.equal(canonicalSport("football"), "FUTBOL");
  assert.equal(canonicalSport("SOCCER"), "FUTBOL");
  assert.equal(canonicalSport("Futbol"), "FUTBOL");
});

test("spor: Basketball yazim farklari ayni spora cozuluyor", () => {
  assert.equal(canonicalSport("Basketball"), "BASKETBOL");
  assert.equal(canonicalSport("basketball"), "BASKETBOL");
  assert.equal(canonicalSport("Basketbol"), "BASKETBOL");
});

test("spor: Football ile Basketball ASLA ayni degil", () => {
  assert.notEqual(canonicalSport("Football"), canonicalSport("Basketball"));
});

test("spor: farkli spor eslesmeyi dogrudan keser", () => {
  const football = makeMatch({
    sport: "FUTBOL",
    home: "Arsenal",
    away: "Chelsea",
  });
  const basketball = makeMatch({
    sport: "BASKETBOL",
    home: "Arsenal",
    away: "Chelsea",
  });

  const result = compareMatches(football, basketball);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "sport-mismatch");
});

/* =========================================================================
 * TAKIM - birebir, normalizasyon, alias
 * ====================================================================== */

test("takim: birebir ayni ad", () => {
  const r = compareTeams("Arsenal", "Arsenal");
  assert.equal(r.score, 100);
  assert.equal(r.stage, "exact");
});

test("takim: FC / jenerik ek farki eslesmeyi bozmaz", () => {
  assert.ok(teamsMatch("Manchester United FC", "Manchester United"));
  assert.ok(teamsMatch("Arsenal", "Arsenal FC"));
  assert.ok(teamsMatch("AS Monaco", "Monaco"));
  assert.ok(teamsMatch("AC Brive", "Brive"));
});

test("takim: alias uzerinden eslesme (fuzzy'den once ve daha guvenilir)", () => {
  const r = compareTeams("Man Utd", "Manchester United");
  assert.ok(r.score >= T);
  assert.ok(
    ["exact", "alias"].includes(r.stage),
    `beklenmeyen asama: ${r.stage}`
  );
});

test("takim: noktalama farki (Paris Saint-Germain)", () => {
  assert.ok(teamsMatch("Paris Saint-Germain", "Paris Saint Germain"));
  assert.ok(teamsMatch("PSG", "Paris Saint-Germain"));
});

test("takim: kisaltma (Dep. La Guaira)", () => {
  assert.ok(teamsMatch("Dep. La Guaira", "Deportivo La Guaira"));
  assert.ok(teamsMatch("La Guaira", "Deportivo La Guaira"));
});

test("takim: Turkce exonim (gercek veriden)", () => {
  assert.ok(teamsMatch("Bayern Münih", "Bayern Munich"));
  assert.ok(teamsMatch("Spartak Moskova", "Spartak Moscow"));
  assert.ok(teamsMatch("Sparta Prag", "AC Sparta Praha"));
  assert.ok(teamsMatch("Slovakya", "Slovakia"));
  assert.ok(teamsMatch("Zimbabve", "Zimbabwe"));
  assert.ok(teamsMatch("Azerbaycan", "Azerbaijan"));
});

test("takim: yazim varyantlari (gercek veriden)", () => {
  assert.ok(teamsMatch("FC Nordsjalland", "Nordsjaelland"));
  assert.ok(teamsMatch("Baracaldo", "Real Aviles CF") === false);
  assert.ok(teamsMatch("Baracaldo", "Barakaldo"));
  assert.ok(teamsMatch("Oldham Athletic", "Oldham Athletic"));
});

test("takim: ardisik bas harfler birlestiriliyor", () => {
  assert.ok(teamsMatch("C A Antoniano", "CA Antoniano"));
  assert.ok(teamsMatch("L. A. Galaxy", "LA Galaxy"));
});

/* =========================================================================
 * TAKIM - YANLIS POZITIFLER  (en kritik grup)
 * ====================================================================== */

test("yanlis pozitif: sadece 'City' ortak", () => {
  assert.ok(!teamsMatch("Manchester City", "Leicester City"));
});

test("yanlis pozitif: sadece 'Real' ortak", () => {
  assert.ok(!teamsMatch("Real Madrid", "Real Sociedad"));
  assert.ok(!teamsMatch("Real Madrid", "Real Betis"));
});

test("yanlis pozitif: sadece 'Sporting' / 'Racing' ortak", () => {
  assert.ok(!teamsMatch("Sporting CP", "Sporting Gijon"));
  assert.ok(!teamsMatch("Racing Club", "Racing Santander"));
});

test("yanlis pozitif: kisaltma bas harfleri (gercekten yasanmis hata)", () => {
  // "hc kosice" bas harfleri "hk" -> eski kod bunu %100 esleme saniyordu.
  assert.ok(!teamsMatch("HC Kosice", "HK Poprad"));
  // "ce" -> "Criciuma EC" bas harfleri; iki ayri Brezilya kulubu.
  assert.ok(!teamsMatch("CE Gramadense RS", "Criciuma EC"));
  assert.ok(!teamsMatch("Pelotas RS", "Operario Ferroviario EC PR"));
});

test("dogru akronim eslesmesi korunuyor", () => {
  assert.ok(teamsMatch("QPR", "Queens Park Rangers"));
  assert.ok(teamsMatch("IPK", "Iisalmen Peli-Karhut"));
  assert.ok(teamsMatch("KTP", "Kotkan Tyovaen Palloilijat"));
});

/* =========================================================================
 * TAKIM NITELEYICILERI  (B takimi / kadinlar / altyapi)
 * ====================================================================== */

test("niteleyici: B takimi ayri takimdir", () => {
  assert.ok(!teamsMatch("Barcelona", "Barcelona B"));
  assert.equal(
    compareTeams("Barcelona", "Barcelona B").reason,
    "qualifier-mismatch"
  );
});

test("niteleyici: kadin takimi ayri takimdir", () => {
  assert.ok(!teamsMatch("Barcelona", "Barcelona Women"));
  assert.ok(!teamsMatch("Barcelona", "Barcelona (W)"));
});

test("niteleyici: altyapi takimi ayri takimdir", () => {
  assert.ok(!teamsMatch("Manchester United", "Manchester United U21"));
  assert.ok(!teamsMatch("Barcelona", "Barcelona U19"));
});

test("niteleyici: rezerv/ikinci takim ayri takimdir", () => {
  assert.ok(!teamsMatch("River Plate", "River Plate II"));
  assert.ok(!teamsMatch("River Plate", "River Plate Reserves"));
});

test("niteleyici: ayni niteleyici iki tarafta da varsa eslesir", () => {
  assert.ok(teamsMatch("Barcelona B", "Barcelona B"));
  assert.ok(teamsMatch("Corinthians (W)", "Corinthians SP (Wom)"));
  assert.ok(
    teamsMatch("Central Cordoba Reserve", "Central Cordoba SdE (Reserves)")
  );
});

test("niteleyici: tenis bas harfleri niteleyici sayilmaz", () => {
  // "Recek D" / "D. Recek" ayni oyuncudur; sondaki tek harf burada
  // rezerv takim isareti DEGIL, isim bas harfidir.
  assert.ok(teamsMatch("Recek D", "D. Recek"));
  assert.ok(teamsMatch("Andreeva, Mirra", "Mirra Andreeva"));
});

/* =========================================================================
 * LIG
 * ====================================================================== */

const league = (sport, key) => resolveLeague(sport, key);

test("lig: ayni lig farkli yazimlarla eslesir", () => {
  const a = league("FUTBOL", "England - Premier League");
  const b = league("FUTBOL", "England - English Premier League");
  assert.equal(compareLeagues(a, b).hardReject, false);
  assert.ok(compareLeagues(a, b).score >= MATCH_CONFIG.leagueThreshold);
});

test("lig: EPL kisaltmasi kanonik lige cozuluyor", () => {
  assert.equal(
    league("FUTBOL", "England - EPL").canonicalId,
    "england_premier_league"
  );
  assert.equal(
    league("FUTBOL", "England - Premier League").canonicalId,
    "england_premier_league"
  );
});

test("lig: AYNI ADLI FARKLI ULKE ligleri eslesmez", () => {
  const england = league("FUTBOL", "England - Premier League");
  const belarus = league("FUTBOL", "Belarus - Premier League");
  const ukraine = league("FUTBOL", "Ukraine - Premier League");

  assert.equal(compareLeagues(england, belarus).hardReject, true);
  assert.equal(compareLeagues(england, ukraine).hardReject, true);
});

test("lig: ulke adi farkli yazilsa da ayni ulke (Holland / Netherlands)", () => {
  const a = league("FUTBOL", "Holland - Eredivisie");
  const b = league("FUTBOL", "Netherlands - Eredivisie");

  assert.equal(a.country, b.country);
  assert.equal(compareLeagues(a, b).hardReject, false);
  assert.equal(compareLeagues(a, b).score, 100);
});

test("lig: Turkey / Turkiye ayni ulke", () => {
  const a = league("FUTBOL", "Turkey - Super Lig");
  const b = league("FUTBOL", "Turkiye - Super Lig");
  assert.equal(a.country, b.country);
  assert.equal(compareLeagues(a, b).hardReject, false);
});

test("lig: bolge kovalari kati ulke kisiti olmaz", () => {
  // betist "International Clubs", mavibet/virusbet "Europe" diyor.
  const a = league("FUTBOL", "International Clubs - UEFA Champions League");
  const b = league("FUTBOL", "Europe - UEFA Champions League - League Stage");

  assert.equal(compareLeagues(a, b).hardReject, false);
  assert.equal(a.canonicalId, "uefa_champions_league");
  assert.equal(b.canonicalId, "uefa_champions_league");
});

test("lig: ulke olmayan degerler ulke sanilmaz", () => {
  // betist ragbide ulke alanina "Rugby Union" yaziyor.
  const a = league("RAGBI", "Rugby Union - France Top 14");
  const b = league("RAGBI", "France - Top 14");
  assert.equal(compareLeagues(a, b).hardReject, false);
});

test("lig: kadinlar ligi erkekler ligiyle eslesmez", () => {
  const men = league("FUTBOL", "Argentina - Primera Division");
  const women = league("FUTBOL", "Argentina - Primera Division, Women");

  const r = compareLeagues(men, women);
  assert.equal(r.hardReject, true);
  assert.equal(r.reason, "league-qualifier-mismatch");
});

test("lig: guvenilir sekilde farkli kanonik ligler eslesmez", () => {
  const pl = league("FUTBOL", "England - Premier League");
  const ch = league("FUTBOL", "England - Championship");

  const r = compareLeagues(pl, ch);
  assert.equal(r.hardReject, true);
  assert.equal(r.reason, "different-canonical-league");
});

/* =========================================================================
 * TARIH / SAAT
 * ====================================================================== */

test("saat: epoch donusumu", () => {
  assert.equal(toEpochMs("2026-09-24", "20:00"), Date.UTC(2026, 8, 24, 17, 0));
  assert.equal(toEpochMs("2026-09-24", null), null);
  assert.equal(toEpochMs(null, "20:00"), null);
  assert.equal(toEpochMs("2026-09-24", "25:00"), null);
});

test("saat: gece yarisini asan fark dogru hesaplaniyor", () => {
  // 23:50 ile ertesi gun 00:10 arasi 20 dakikadir, 23 saat 40 degil.
  const a = toEpochMs("2026-09-24", "23:50");
  const b = toEpochMs("2026-09-25", "00:10");
  assert.equal(calculateTimeDifference(a, b), 20);
});

test("saat: timezone farki dogru cozuluyor", () => {
  // Site A: 2026-09-24 00:30 Europe/Istanbul (UTC+3)
  // Site B: 2026-09-23 21:30 UTC              (offset 0)
  const a = toEpochMs("2026-09-24", "00:30", 180);
  const b = toEpochMs("2026-09-23", "21:30", 0);
  assert.equal(a, b, "ayni ana isaret etmeli");
  assert.equal(calculateTimeDifference(a, b), 0);
});

test("tarih: komsu gun anahtari", () => {
  assert.equal(dateKeyOffset("2026-09-24", 1), "2026-09-25");
  assert.equal(dateKeyOffset("2026-09-01", -1), "2026-08-31");
  assert.equal(dateKeyOffset("2027-01-01", -1), "2026-12-31");
  assert.equal(dateKeyOffset("gecersiz", 1), null);
});

test("saat: saat bilgisi yoksa eleme yapilmaz", () => {
  const r = compareMatchTimes(
    { date: "2026-09-24", epoch: null },
    { date: "2026-09-24", epoch: toEpochMs("2026-09-24", "20:00") }
  );
  assert.equal(r.comparable, false);
  assert.equal(r.isDifferent, false);
  assert.equal(r.plausible, true);
});

test("saat: ayni gun buyuk fark elenmez (gercek sinyaldir)", () => {
  // Boks kartlari gercekten 06:00 ve 22:00 diye farkli ilan edilebiliyor.
  const r = compareMatchTimes(
    { date: "2026-09-26", epoch: toEpochMs("2026-09-26", "06:00") },
    { date: "2026-09-26", epoch: toEpochMs("2026-09-26", "22:00") }
  );
  assert.equal(r.plausible, true);
  assert.equal(r.isDifferent, true);
  assert.equal(r.diffMinutes, 960);
});

/* =========================================================================
 * ADAY DARALTMA (INDEKS)
 * ====================================================================== */

function makeMatch(overrides = {}) {
  const sport = overrides.sport ?? "FUTBOL";
  const date = overrides.date ?? "2026-09-24";
  const leagueKey = overrides.leagueKey ?? "England - Premier League";

  return {
    sport,
    date,
    time: overrides.time ?? "20:00",
    epoch: toEpochMs(date, overrides.time ?? "20:00"),
    home: overrides.home ?? "Arsenal",
    away: overrides.away ?? "Chelsea",
    leagueRaw: leagueKey,
    leagueInfo: resolveLeague(sport, leagueKey),
  };
}

test("indeks: farkli spordaki maclar aday bile olmaz", () => {
  const list = [
    makeMatch({ sport: "BASKETBOL", home: "Arsenal", away: "Chelsea" }),
  ];
  const index = buildMatchIndex(list);
  const query = makeMatch({
    sport: "FUTBOL",
    home: "Arsenal",
    away: "Chelsea",
  });

  assert.deepEqual(findMatchCandidates(query, index), []);
});

test("indeks: farkli tarihteki maclar aday olmaz (+-1 gun disi)", () => {
  const list = [makeMatch({ date: "2026-10-05" })];
  const index = buildMatchIndex(list);
  const query = makeMatch({ date: "2026-09-24" });

  assert.deepEqual(findMatchCandidates(query, index), []);
});

test("indeks: komsu gun adayi bulunur (gece yarisi kaymasi icin)", () => {
  const list = [makeMatch({ date: "2026-09-25", time: "00:10" })];
  const index = buildMatchIndex(list);
  const query = makeMatch({ date: "2026-09-24", time: "23:50" });

  assert.equal(findMatchCandidates(query, index).length, 1);
});

test("indeks: ortak token'i olmayan maclar aday olmaz", () => {
  const list = [makeMatch({ home: "Bayern Munich", away: "Dortmund" })];
  const index = buildMatchIndex(list);
  const query = makeMatch({ home: "Arsenal", away: "Chelsea" });

  assert.deepEqual(findMatchCandidates(query, index), []);
});

test("indeks: yazim varyantlari ONEK sayesinde aday kalir", () => {
  const list = [makeMatch({ home: "Nordsjaelland", away: "Odense" })];
  const index = buildMatchIndex(list);
  const query = makeMatch({ home: "FC Nordsjalland", away: "Odense BK" });

  assert.equal(findMatchCandidates(query, index).length, 1);
});

/* =========================================================================
 * UCTAN UCA MAC KARSILASTIRMASI
 * ====================================================================== */

test("mac: ayni mac farkli yazimlarla eslesir", () => {
  const a = makeMatch({ home: "Manchester United", away: "Arsenal" });
  const b = makeMatch({ home: "Man Utd", away: "Arsenal FC" });

  const r = compareMatches(a, b);
  assert.equal(r.ok, true);
  assert.ok(r.confidence >= MATCH_CONFIG.possibleConfidence);
});

test("mac: ev sahibi farkliysa eslesmez", () => {
  const a = makeMatch({ home: "Manchester United", away: "Arsenal" });
  const b = makeMatch({ home: "Manchester City", away: "Arsenal" });

  assert.equal(compareMatches(a, b).ok, false);
});

test("mac: takimlar benzese de FARKLI LIG eslesmez", () => {
  const a = makeMatch({ leagueKey: "England - Premier League" });
  const b = makeMatch({ leagueKey: "England - Championship" });

  const r = compareMatches(a, b);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "different-canonical-league");
});

test("mac: ayni isimli takim farkli sporda karismaz", () => {
  const a = makeMatch({
    sport: "FUTBOL",
    leagueKey: "England - Premier League",
  });
  const b = makeMatch({
    sport: "BASKETBOL",
    leagueKey: "England - Premier League",
  });

  assert.equal(compareMatches(a, b).ok, false);
});

test("mac: ayni takimlar ayni gun iki kez oynarsa saat ayirt eder", () => {
  const early = makeMatch({
    sport: "BEYZBOL",
    time: "14:00",
    leagueKey: "United States - MLB",
  });
  const late = makeMatch({
    sport: "BEYZBOL",
    time: "20:00",
    leagueKey: "United States - MLB",
  });

  const sameTime = makeMatch({
    sport: "BEYZBOL",
    time: "14:05",
    leagueKey: "United States - MLB",
  });

  // Ikisi de eslesebilir, ama saati yakin olanin guveni daha yuksek olmali.
  const toEarly = compareMatches(sameTime, early);
  const toLate = compareMatches(sameTime, late);

  assert.equal(toEarly.ok, true);
  assert.ok(
    toEarly.confidence > toLate.confidence,
    `saati yakin olan tercih edilmeli (${toEarly.confidence} vs ${toLate.confidence})`
  );
});

test("mac: ev/deplasman ters sirali kayit yakalanir", () => {
  const a = makeMatch({ home: "Esteli", away: "Matagalpa" });
  const b = makeMatch({ home: "Matagalpa", away: "Esteli" });

  const r = compareMatches(a, b);
  assert.equal(r.ok, true);
  assert.equal(r.flipped, true);
});

test("mac: guven skoru 0-1 araliginda ve karar tutarli", () => {
  const a = makeMatch({ home: "Manchester United", away: "Arsenal" });
  const b = makeMatch({ home: "Manchester United", away: "Arsenal" });

  const r = compareMatches(a, b);
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  assert.equal(r.decision, MATCH_RESULT.MATCH);
});

/* =========================================================================
 * NORMALIZASYON - ASIRI AGRESIF OLMAMALI
 * ====================================================================== */

test("normalize: 'La' sehir kisaltmasi olarak ACILMAZ", () => {
  // Eski kod "La" -> "Los Angeles" aciyor ve 49 takim adini bozuyordu.
  assert.ok(!normalizeTeamName("Deportivo La Coruna").includes("angeles"));
  assert.ok(!normalizeTeamName("Gimnasia La Plata").includes("angeles"));
  assert.ok(!normalizeTeamName("Estudiantes de La Plata").includes("angeles"));
});

test("normalize: farkli 'La Plata' kulupleri birbirine karismaz", () => {
  assert.ok(!teamsMatch("Gimnasia La Plata", "Estudiantes de La Plata"));
});

test("normalize: sezon bilgisi lig adindan atiliyor", () => {
  assert.equal(
    normalizeLeagueName("Turkiye Super Lig 2026/2027"),
    normalizeLeagueName("Turkiye Super Lig")
  );
});

test("benzerlik: simetrik ve sinirli", () => {
  assert.equal(
    similarityRatio("arsenal", "chelsea"),
    similarityRatio("chelsea", "arsenal")
  );
  assert.ok(similarityRatio("arsenal", "arsenal") === 100);
  assert.ok(similarityRatio("", "arsenal") === 0);
});

/* =========================================================================
 * DAYANIKLILIK
 * ====================================================================== */

test("bozuk girdi surecin tamamini dusurmez", () => {
  assert.doesNotThrow(() => compareTeams(null, "Arsenal"));
  assert.doesNotThrow(() => compareTeams(undefined, undefined));
  assert.doesNotThrow(() => normalizeTeamName(null));
  assert.doesNotThrow(() => resolveLeague("FUTBOL", null));
  assert.doesNotThrow(() => resolveTeam(""));

  assert.equal(compareTeams(null, "Arsenal").score, 0);
});
