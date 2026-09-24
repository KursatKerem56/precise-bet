/**
 * ALIAS VERITABANI YUKLEYICI
 *
 * team_aliases.json ve league_aliases.json MODUL YUKLENIRKEN BIR KEZ
 * okunur ve Map indeksine cevrilir. Her karsilastirmada diskten okuma ya da
 * dizi taramasi YOK:
 *
 *   normalizedAlias                      -> canonicalTeamId     (O(1))
 *   sport|country|normalizedLeagueAlias  -> canonicalLeagueId   (O(1))
 *
 * Alias eslesmesi bulanik eslesmeden daha guvenilir kabul edildigi icin bu
 * dosyalar OTOMATIK GUNCELLENMEZ; bulanik eslestiricinin onerileri
 * unresolved.js uzerinden ayri bir "suggestions" ciktisina dusurulur.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { foldText } from "./text.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bozuk/eksik alias dosyasi butun karsilastirmayi dusurmemeli:
 * alias'siz calismak (sadece bulanik eslestirme) hic calismamaktan iyidir. */
function loadJson(fileName, fallback) {
  try {
    return JSON.parse(readFileSync(join(HERE, fileName), "utf8"));
  } catch (error) {
    console.warn(
      `[MATCHING] ${fileName} okunamadi, alias'siz devam ediliyor: ${error.message}`
    );
    return fallback;
  }
}

/* =========================================================================
 * TAKIM ALIAS INDEKSI
 * ====================================================================== */

const teamData = loadJson("team_aliases.json", { teams: {} });

/** foldText(alias) -> { id, canonical } */
const teamByAlias = new Map();

/** id -> { id, canonical, aliases } */
const teamById = new Map();

for (const [id, entry] of Object.entries(teamData.teams ?? {})) {
  // "_comment" gibi aciklama anahtarlari kayit degildir.
  if (id.startsWith("_") || !entry || typeof entry !== "object") continue;

  const canonical = entry.canonical ?? id;
  const record = { id, canonical, aliases: entry.aliases ?? [] };
  teamById.set(id, record);

  const names = new Set([canonical, ...(entry.aliases ?? [])]);

  // Source'a ozel yazimlar (bkz. league_aliases.json'daki ayni yapi).
  // Uc sitenin gercek verisinde su an source'a ozel kurala ihtiyac YOK --
  // ayni varyant birden fazla sitede geciyor -- ama semada destekleniyor.
  for (const list of Object.values(entry.sources ?? {})) {
    for (const name of list ?? []) names.add(name);
  }

  for (const name of names) {
    const key = foldText(name);
    if (!key) continue;

    const clash = teamByAlias.get(key);
    if (clash && clash.id !== id) {
      console.warn(
        `[MATCHING] takim alias catismasi: "${name}" hem ${clash.id} hem ${id}`
      );
      continue;
    }

    teamByAlias.set(key, record);
  }
}

/** Normalize edilmis bir adi kanonik takim kaydina cevirir; yoksa null. */
export const resolveTeamAlias = (foldedName) =>
  teamByAlias.get(foldedName) ?? null;

export const getTeamById = (id) => teamById.get(id) ?? null;

/* =========================================================================
 * LIG ALIAS INDEKSI
 * ====================================================================== */

const leagueData = loadJson("league_aliases.json", {
  countries: {},
  regions: [],
  leagues: {},
});

/** foldText(ulke yazimi) -> kanonik ulke adi */
const countryByAlias = new Map();

for (const [canonical, aliases] of Object.entries(leagueData.countries ?? {})) {
  for (const name of [canonical, ...(aliases ?? [])]) {
    const key = foldText(name);
    if (key) countryByAlias.set(key, canonical);
  }
}

/** Ulke DEGIL, bolge kovasi olan anahtarlar. */
const regionKeys = new Set(
  (leagueData.regions ?? []).map((r) => foldText(r)).filter(Boolean)
);

/**
 * Ulke adini tekillestirir.
 *
 * `known` = bu deger alias tablosunda TANIDIGIMIZ bir ulke mi? Ulke farki
 * ancak IKI TARAF da taninan bir ulkeyse KATI kisit olarak kullanilir.
 * Aksi halde betist'in ulke yerine koydugu "Rugby Union" / "ATP" gibi
 * degerler gercek eslesmeleri yanlislikla elerdi.
 *
 * @returns {{ country: string|null, isRegion: boolean, known: boolean }}
 */
export function resolveCountry(raw) {
  const key = foldText(raw);
  if (!key) return { country: null, isRegion: false, known: false };

  if (regionKeys.has(key))
    return { country: null, isRegion: true, known: false };

  const canonical = countryByAlias.get(key);

  return {
    country: canonical ?? String(raw).trim(),
    isRegion: false,
    known: canonical !== undefined,
  };
}

/** "sport|country|leagueAlias" -> lig kaydi */
const leagueByKey = new Map();

/** id -> lig kaydi */
const leagueById = new Map();

/** Ulkesiz (yalnizca sport + ad) gerileme indeksi: ad -> lig kayitlari */
const leagueByNameOnly = new Map();

const leagueKey = (sportKey, country, foldedName) =>
  `${sportKey ?? "*"}|${foldText(country ?? "") || "*"}|${foldedName}`;

/**
 * Lig kayitlarini indeksler. `sport` alani katalog alias'i olarak yazilir
 * ("football"), burada katalog anahtarina ("FUTBOL") cevrilir -- boylece
 * JSON okunakli kalirken kod tek bir spor temsili kullanir.
 */
export function buildLeagueIndex(resolveSportKey) {
  leagueByKey.clear();
  leagueById.clear();
  leagueByNameOnly.clear();

  for (const [id, entry] of Object.entries(leagueData.leagues ?? {})) {
    if (id.startsWith("_") || !entry || typeof entry !== "object") continue;

    const sportKey = resolveSportKey(entry.sport);
    const record = {
      id,
      canonical: entry.canonical ?? id,
      sportKey,
      country: entry.country ?? null,
      region: entry.region ?? null,
    };

    leagueById.set(id, record);

    const names = new Set([record.canonical, ...(entry.aliases ?? [])]);
    for (const list of Object.values(entry.sources ?? {})) {
      for (const name of list ?? []) names.add(name);
    }

    for (const name of names) {
      const folded = foldText(name);
      if (!folded) continue;

      // Ulkeli anahtar: ayni adli farkli ulke ligleri ("Premier League" -
      // England / Russia / Wales) birbirine KARISMAZ.
      const withCountry = leagueKey(sportKey, record.country, folded);
      if (!leagueByKey.has(withCountry)) leagueByKey.set(withCountry, record);

      // Ulke bilgisi olmayan kayitlar icin sport+ad anahtari.
      if (!record.country) {
        const withoutCountry = leagueKey(sportKey, null, folded);
        if (!leagueByKey.has(withoutCountry))
          leagueByKey.set(withoutCountry, record);
      }

      const nameKey = `${sportKey ?? "*"}|${folded}`;
      if (!leagueByNameOnly.has(nameKey)) leagueByNameOnly.set(nameKey, []);
      leagueByNameOnly.get(nameKey).push(record);
    }
  }

  return leagueByKey.size;
}

/**
 * Lig adini kanonik kayda cozer.
 *
 * @param {string} sportKey    katalog spor anahtari (FUTBOL ...)
 * @param {string|null} country kanonik ulke adi (yoksa null)
 * @param {string} foldedName  normalize edilmis lig adi
 * @returns {{ record: object, confident: boolean }|null}
 */
export function resolveLeagueAlias(sportKey, country, foldedName) {
  if (!foldedName) return null;

  const exact = leagueByKey.get(leagueKey(sportKey, country, foldedName));
  if (exact) return { record: exact, confident: true };

  // Ulkesiz gerileme: TEK aday varsa kabul, ama guven DUSUK isaretlenir.
  // Birden fazla aday varsa ("Premier League" bircok ulkede) karar VERMEYIZ.
  const candidates = leagueByNameOnly.get(`${sportKey ?? "*"}|${foldedName}`);
  if (!candidates || candidates.length !== 1) return null;

  const [candidate] = candidates;

  // KRITIK: sorgunun ULKESI varsa ve aday BASKA bir ulkenin ligiyse
  // gerileme YAPILMAZ. Aksi halde "Belarus - Premier League" adi tek
  // eslesen kayda, yani INGILTERE Premier League'ine cozulurdu ve iki
  // ayri ulkenin ligi ayni kanonik id'yi paylasirdi.
  //
  // Ulkesi olmayan adaylar (UEFA Champions League gibi kitasel
  // turnuvalar) bu kisitin disinda; onlarin zaten ulkesi yok.
  if (country && candidate.country && candidate.country !== country) {
    return null;
  }

  return { record: candidate, confident: false };
}

export const getLeagueById = (id) => leagueById.get(id) ?? null;

/** Oneri uretmek icin kanonik adlarin listesi (unresolved.js kullanir). */
export const listLeagueRecords = () => [...leagueById.values()];
export const listTeamRecords = () => [...teamById.values()];

export const ALIAS_STATS = {
  teams: teamById.size,
  teamAliases: teamByAlias.size,
  countries: countryByAlias.size,
  regions: regionKeys.size,
};
