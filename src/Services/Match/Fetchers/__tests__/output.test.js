/**
 * Ortak cikti modeli testleri.
 *
 * Bu katman uc fetcher'in da ciktisini uretiyor; buradaki bir regresyon
 * her uc siteyi birden bozar.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MatchOutput, createDateFilter } from "../Core/output.js";

const sample = {
  eventId: "1",
  leagueId: "10",
  leagueName: "Super Lig",
  countryName: "Turkiye",
  home: "Galatasaray",
  away: "Fenerbahce",
  date: "2026-09-18",
  time: "20:00",
};

test("cikti sekli eski fetcher'larla ayni", () => {
  const output = new MatchOutput();

  output.add("FUTBOL", sample);

  const data = output.toSorted();

  assert.deepEqual(data.FUTBOL["Turkiye - Super Lig"]["2026-09-18"], [
    {
      eventId: "1",
      leagueId: "10",
      home: "Galatasaray",
      away: "Fenerbahce",
      time: "20:00",
    },
  ]);
});

test("eski dort spor anahtari bos olsa bile her zaman var", () => {
  const data = new MatchOutput().toSorted();

  assert.deepEqual(Object.keys(data), [
    "FUTBOL",
    "BASKETBOL",
    "VOLEYBOL",
    "TENIS",
  ]);
});

test("yeni sporlar eski anahtarlarin ARDINA eklenir", () => {
  const output = new MatchOutput();

  output.add("MASA_TENISI", { ...sample, eventId: "2" });

  const keys = Object.keys(output.toSorted());

  assert.deepEqual(keys.slice(0, 4), [
    "FUTBOL",
    "BASKETBOL",
    "VOLEYBOL",
    "TENIS",
  ]);
  assert.ok(keys.includes("MASA_TENISI"));
});

test("ayni eventId iki kez eklenmez", () => {
  const output = new MatchOutput();

  assert.equal(output.add("FUTBOL", sample), true);
  assert.equal(output.add("FUTBOL", sample), false);

  assert.equal(output.total, 1);
  assert.equal(output.stats.duplicate, 1);
});

test("eksik takim / tarih tum fetch'i bozmadan atlanir", () => {
  const output = new MatchOutput();

  // Outright kaydi: tek taraf.
  assert.equal(output.add("FUTBOL", { ...sample, away: "" }), false);
  assert.equal(output.add("FUTBOL", { ...sample, home: null }), false);
  assert.equal(output.add("FUTBOL", { ...sample, date: "" }), false);
  assert.equal(output.add("", sample), false);

  assert.equal(output.stats.skipped, 4);

  // Bozuk kayitlardan sonra saglam kayit hala ekleniyor.
  assert.equal(output.add("FUTBOL", sample), true);
});

test("lig adi yoksa leagueId'den uretilir, ulke yoksa ayrac konmaz", () => {
  const output = new MatchOutput();

  output.add("FUTBOL", {
    ...sample,
    eventId: "a",
    leagueName: "",
    countryName: "",
  });

  output.add("FUTBOL", {
    ...sample,
    eventId: "b",
    leagueName: "ATP",
    countryName: "",
  });

  const leagues = Object.keys(output.toSorted().FUTBOL);

  assert.ok(leagues.includes("LIG_10"));
  assert.ok(leagues.includes("ATP"));
});

test("maclar saate, esitlikte takim adina gore siralanir", () => {
  const output = new MatchOutput();

  output.add("FUTBOL", { ...sample, eventId: "1", time: "22:00" });
  output.add("FUTBOL", { ...sample, eventId: "2", time: "18:00" });
  output.add("FUTBOL", {
    ...sample,
    eventId: "3",
    time: "18:00",
    home: "Anadolu",
  });

  const list = output.toSorted().FUTBOL["Turkiye - Super Lig"]["2026-09-18"];

  assert.deepEqual(
    list.map((m) => [m.time, m.home]),
    [
      ["18:00", "Anadolu"],
      ["18:00", "Galatasaray"],
      ["22:00", "Galatasaray"],
    ]
  );
});

test("ligler ve tarihler sirali", () => {
  const output = new MatchOutput();

  output.add("FUTBOL", { ...sample, eventId: "1", leagueName: "Zonguldak" });
  output.add("FUTBOL", { ...sample, eventId: "2" }); // "Super Lig"
  output.add("FUTBOL", { ...sample, eventId: "3", leagueName: "Ankara" });
  // Ayni ligde, farkli tarihte ikinci mac: tarih siralamasini gormek icin.
  output.add("FUTBOL", {
    ...sample,
    eventId: "4",
    leagueName: "Ankara",
    date: "2026-09-01",
  });

  const sport = output.toSorted().FUTBOL;

  // Ligler Turkce siralama kurallarina gore alfabetik.
  assert.deepEqual(Object.keys(sport), [
    "Turkiye - Ankara",
    "Turkiye - Super Lig",
    "Turkiye - Zonguldak",
  ]);

  assert.deepEqual(Object.keys(sport["Turkiye - Ankara"]), [
    "2026-09-01",
    "2026-09-18",
  ]);
});

test("tarih filtresi", () => {
  assert.equal(createDateFilter({}), null, "sinir yoksa filtre de yok");

  const exact = createDateFilter({ dates: ["2026-09-18"] });
  assert.equal(exact("2026-09-18"), true);
  assert.equal(exact("2026-09-19"), false);

  const range = createDateFilter({ from: "2026-09-10", to: "2026-09-20" });
  assert.equal(range("2026-09-15"), true);
  assert.equal(range("2026-09-01"), false);
  assert.equal(range("2026-09-25"), false);

  const output = new MatchOutput({ dateFilter: range });
  assert.equal(output.add("FUTBOL", { ...sample, date: "2026-01-01" }), false);
  assert.equal(output.stats.filtered, 1);
});
