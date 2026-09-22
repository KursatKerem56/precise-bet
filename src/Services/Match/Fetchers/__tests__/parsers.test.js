/**
 * Parser testleri -- ag erisimi YOK, gercek yanitlardan alinmis kisa
 * fixture'lar kullaniliyor.
 *
 * Amac: site HTML/JSON bicimi degistiginde bunu ilk fark eden yer burasi
 * olsun, uretimde bos JSON degil.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSportMenu,
  parseEventRecords,
  splitParticipants,
} from "../betist-match-fetcher.js";

import { discoverSports } from "../mavibet-match-fetcher.js";

import {
  formatEpochMs,
  formatEpochSeconds,
  parseLocalDateTime,
} from "../Core/time.js";

import { decodeHtmlEntities, stripTags, parseAttributes, foldName } from "../Core/text.js";

/** Testler sirasinda log gurultusu olmasin diye. */
const noop = () => undefined;

const silentLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  isDebug: () => false,
};

/* ---------------------------------------------------------------- betist -- */

// Gercek home.php ciktisindan kisaltilmis parca.
const BETIST_MENU_HTML = `
<div class="sports">
  <i id="check__3" class="b-check sport" layout="single_line_betist_1x2"></i>
  <span class="sport-name">Futbol</span>
  <i id="check__6754" class="b-check stage"></i>
  <i id="check__58814" class="b-check stage"></i>
  <i id="check__58814" class="b-check stage"></i>
  <i id="check__5" class="b-check sport" layout="single_line_betist_12"></i>
  <span class="sport-name">Basketbol</span>
  <i id="check__9001" class="b-check stage"></i>
  <i id="check__99" class="b-check other"></i>
</div>`;

test("betist: spor menusu spor + lig id'lerini cikariyor", () => {
  const menu = parseSportMenu(BETIST_MENU_HTML);

  assert.equal(menu.length, 2);

  assert.deepEqual(
    { ...menu[0], start: undefined },
    {
      sportId: "3",
      name: "Futbol",
      layoutSchemaCode: "single_line_betist_1x2",
      leagueIds: ["6754", "58814"], // tekrar eden id tekillestirildi
      start: undefined,
    }
  );

  assert.equal(menu[1].sportId, "5");
  assert.deepEqual(menu[1].leagueIds, ["9001"]);
});

test("betist: 'stage' olmayan isaretciler lig sayilmiyor", () => {
  const menu = parseSportMenu(BETIST_MENU_HTML);

  assert.ok(!menu.some((s) => s.leagueIds.includes("99")));
});

test("betist: bos/alakasiz HTML bos menu doner, patlamaz", () => {
  assert.deepEqual(parseSportMenu(""), []);
  assert.deepEqual(parseSportMenu("<html><body>bakim</body></html>"), []);
});

test("betist: rev niteliginden mac kayitlari cikiyor", () => {
  const html = `
    <div rev="{&quot;mid&quot;:&quot;14841808&quot;,&quot;lid&quot;:&quot;6754&quot;,&quot;sport_id&quot;:&quot;3&quot;,&quot;event&quot;:&quot;Us Biskra - JS Saoura&quot;,&quot;event_start_time&quot;:&quot;2026-09-22 19:00:00&quot;,&quot;league_name&quot;:&quot;Ligue 1&quot;,&quot;country_name&quot;:&quot;Algeria&quot;}"></div>
    <div rev="bu json degil"></div>
    <div rev="{bozuk json"></div>
    <div rev="{&quot;mid&quot;:&quot;999&quot;}"></div>
  `;

  const events = parseEventRecords(html);

  // Bozuk ve eksik alanli kayitlar atlandi, saglam olan alindi.
  assert.equal(events.length, 1);
  assert.equal(events[0].mid, "14841808");
  assert.equal(events[0].event, "Us Biskra - JS Saoura");
});

test("betist: ayni mac iki kez gecerse tekillestirilir", () => {
  const rev = `{&quot;mid&quot;:&quot;1&quot;,&quot;lid&quot;:&quot;2&quot;,&quot;event&quot;:&quot;A - B&quot;,&quot;event_start_time&quot;:&quot;2026-09-22 19:00:00&quot;}`;

  assert.equal(parseEventRecords(`<i rev="${rev}"></i><i rev="${rev}"></i>`).length, 1);
});

test("betist: takim ayirma", () => {
  assert.deepEqual(splitParticipants("Galatasaray - Fenerbahce"), {
    home: "Galatasaray",
    away: "Fenerbahce",
  });

  // Ayrac yoksa outright kaydidir; away bos kalir ve cikti katmani eler.
  assert.deepEqual(splitParticipants("Sampiyon kim olur"), {
    home: "Sampiyon kim olur",
    away: "",
  });

  // Takim adinin kendisinde tire varsa ILK " - " ayraci kullanilir.
  assert.deepEqual(splitParticipants("Hertha-Berlin - Bayern"), {
    home: "Hertha-Berlin",
    away: "Bayern",
  });

  assert.deepEqual(splitParticipants(null), { home: "", away: "" });
});

/* --------------------------------------------------------------- mavibet -- */

// Gercek disciplinesV2 dokumunden alinmis alanlar.
const MAVIBET_DISCIPLINES = [
  {
    _type: "SPORT",
    id: "1",
    name: "Football",
    numberOfUpcomingMatches: 1271,
    hasMatches: true,
    showEventCategory: false,
    isVirtual: false,
  },
  {
    _type: "SPORT",
    id: "3",
    name: "Tennis",
    numberOfUpcomingMatches: 418,
    hasMatches: true,
    // Tenis ulke yerine "event category" agaci kullaniyor -- eskiden bu
    // koda sabit yazilmisti, artik sitenin kendi bayragindan okunuyor.
    showEventCategory: true,
    isVirtual: false,
  },
  {
    _type: "SPORT",
    id: "83",
    name: "Virtual Sports",
    numberOfUpcomingMatches: 278,
    hasMatches: false,
    isVirtual: true,
  },
  {
    _type: "SPORT",
    id: "189",
    name: "Formula 1",
    numberOfUpcomingMatches: 0,
    hasMatches: true,
  },
  {
    _type: "SPORT",
    id: "186",
    name: "Counter-Strike",
    numberOfUpcomingMatches: 57,
    hasMatches: true,
  },
  { _type: "LOCATION", id: "73", name: "Turkiye" },
  null,
];

test("mavibet: spor kesfi", () => {
  const found = discoverSports(MAVIBET_DISCIPLINES, null, silentLogger);

  const keys = found.map((s) => s.sportKey);

  assert.deepEqual(keys, ["FUTBOL", "TENIS"], "sadece uygun sporlar");

  // Sanal spor, maci olmayan spor, katalog disi spor ve SPORT olmayan
  // kayitlar elendi.
  assert.ok(!keys.includes("Virtual Sports"));
  assert.ok(!keys.includes("FORMULA_1"));

  assert.equal(found[0].useEventCategory, false, "futbol -> locations");
  assert.equal(found[1].useEventCategory, true, "tenis -> event category");
});

test("mavibet: buyuk sporlar once sirada", () => {
  const found = discoverSports(MAVIBET_DISCIPLINES, null, silentLogger);

  assert.ok(found[0].upcoming >= found[1].upcoming);
});

test("mavibet: MATCH_SPORTS kisitlamasi uygulanir", () => {
  const found = discoverSports(
    MAVIBET_DISCIPLINES,
    new Set(["TENIS"]),
    silentLogger
  );

  assert.deepEqual(
    found.map((s) => s.sportKey),
    ["TENIS"]
  );
});

test("mavibet: bos/bozuk dokum patlatmaz", () => {
  assert.deepEqual(discoverSports([], null, silentLogger), []);
  assert.deepEqual(
    discoverSports([{}, null, { _type: "SPORT" }], null, silentLogger),
    []
  );
});

/* ------------------------------------------------------------------ zaman -- */

test("zaman: uc farkli birim ayni Turkiye saatine donuyor", () => {
  // 2026-09-18 20:00 Europe/Istanbul == 17:00 UTC
  const utcMs = Date.UTC(2026, 8, 18, 17, 0, 0);

  const expected = { date: "2026-09-18", time: "20:00" };

  assert.deepEqual(formatEpochMs(utcMs), expected, "mavibet (ms)");
  assert.deepEqual(formatEpochSeconds(utcMs / 1000), expected, "virusbet (sn)");
  assert.deepEqual(
    parseLocalDateTime("2026-09-18 20:00:00"),
    expected,
    "betist (yerel metin)"
  );
});

test("zaman: gece yarisini asan degerler dogru gune dusuyor", () => {
  // 21:10 UTC = ertesi gun 00:10 Istanbul
  assert.deepEqual(formatEpochMs(Date.UTC(2026, 8, 18, 21, 10)), {
    date: "2026-09-19",
    time: "00:10",
  });
});

test("zaman: bozuk deger UNKNOWN_DATE doner, patlamaz", () => {
  const unknown = { date: "UNKNOWN_DATE", time: "" };

  for (const bad of [null, undefined, NaN, "abc", {}]) {
    assert.deepEqual(formatEpochMs(bad), unknown, `formatEpochMs(${bad})`);
    assert.deepEqual(formatEpochSeconds(bad), unknown);
  }

  for (const bad of [null, "", "18/09/2026", "2026-09-18"]) {
    assert.deepEqual(parseLocalDateTime(bad), unknown, `parseLocalDateTime(${bad})`);
  }
});

test("zaman: saniyesiz ve 'T' ayracli bicimler de kabul ediliyor", () => {
  assert.deepEqual(parseLocalDateTime("2026-09-18 20:00"), {
    date: "2026-09-18",
    time: "20:00",
  });

  assert.deepEqual(parseLocalDateTime("2026-09-18T20:00:00"), {
    date: "2026-09-18",
    time: "20:00",
  });
});

/* ------------------------------------------------------------------ metin -- */

test("metin: HTML entity cozumu", () => {
  assert.equal(decodeHtmlEntities("&quot;a&quot; &amp; &#39;b&#39;"), `"a" & 'b'`);
  assert.equal(decodeHtmlEntities("&#x41;&#66;"), "AB");
  assert.equal(decodeHtmlEntities("&bilinmeyen;"), "&bilinmeyen;");
});

test("metin: etiket temizleme", () => {
  assert.equal(stripTags("<span>  Futbol  </span>"), "Futbol");
  assert.equal(stripTags("<b>A</b><i>B</i>"), "A B");
});

test("metin: nitelik ayristirma", () => {
  assert.deepEqual(parseAttributes(`<i id="check__3" CLASS='b-check sport'>`), {
    id: "check__3",
    class: "b-check sport",
  });
});

test("metin: foldName camelCase'i ayirip Turkce harfleri katliyor", () => {
  assert.equal(foldName("AmericanFootball"), "american football");
  assert.equal(foldName("Buz Hokeyi"), "buz hokeyi");
  assert.equal(foldName("Santranç"), "santranc");
  assert.equal(foldName("Am. Football"), "am football");
  assert.equal(foldName("Counter-Strike 2"), "counter strike 2");
  assert.equal(foldName(null), "");
});
