import https from "node:https";

const BASE_URL = process.env.BETIST_BASE_URL || "https://bet.betist2103.com";
const HOME_URL = `${BASE_URL}/home.php?domain=&options=`;

// Betist HAR'ında görünen spor ID'leri.
const TARGET_SPORTS = [
  { name: "FUTBOL", sportId: "3" },
  { name: "BASKETBOL", sportId: "5" },
  { name: "TENIS", sportId: "9" },
  { name: "VOLEYBOL", sportId: "10" },
  { name: "BEYZBOL", sportId: "4" },
];

// Sitedeki spor seçimi ilk 10 ligi yükleyecek şekilde çalışıyor.
// "all" yaparsan bütün ligleri 10'arlı gruplar halinde çeker.
const LEAGUE_MODE = process.env.BETIST_LEAGUE_MODE || "first10";
const CHUNK_SIZE = 10;

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
};

function get(url, extraHeaders = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          ...COMMON_HEADERS,
          ...extraHeaders,
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectCount >= 5) {
            res.resume();
            reject(new Error("Çok fazla redirect."));
            return;
          }

          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();

          get(nextUrl, extraHeaders, redirectCount + 1)
            .then(resolve)
            .catch(reject);

          return;
        }

        const chunks = [];

        res.on("data", (chunk) => chunks.push(chunk));

        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");

          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `HTTP ${res.statusCode} ${res.statusMessage || ""}\n${body.slice(
                  0,
                  500
                )}`
              )
            );
            return;
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error("Request timeout."));
    });
  });
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return decodeHtmlEntities(
    value
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function parseSportMenu(html) {
  const markers = [];
  const sportRegex =
    /<i\s+id="check__(\d+)"\s+class="b-check sport"[^>]*layout="([^"]+)"[^>]*>/g;

  let match;

  while ((match = sportRegex.exec(html)) !== null) {
    const afterMarker = html.slice(
      sportRegex.lastIndex,
      sportRegex.lastIndex + 1500
    );
    const nameMatch = afterMarker.match(
      /<span\s+class="sport-name">([\s\S]*?)<\/span>/
    );

    markers.push({
      sportId: match[1],
      layoutSchemaCode: match[2],
      name: nameMatch ? stripTags(nameMatch[1]) : `SPORT_${match[1]}`,
      start: match.index,
    });
  }

  return markers.map((sport, index) => {
    const end =
      index + 1 < markers.length ? markers[index + 1].start : html.length;

    const block = html.slice(sport.start, end);
    const leagueRegex = /<i\s+id="check__(\d+)"\s+class="b-check stage"[^>]*>/g;

    const leagueIds = [];
    const seen = new Set();
    let leagueMatch;

    while ((leagueMatch = leagueRegex.exec(block)) !== null) {
      const id = leagueMatch[1];

      if (!seen.has(id)) {
        seen.add(id);
        leagueIds.push(id);
      }
    }

    return {
      ...sport,
      leagueIds,
    };
  });
}

function buildEventsUrl(leagueIds, layoutSchemaCode) {
  const url = new URL(`${BASE_URL}/getdata.php`);

  url.searchParams.set("sec", "ASIAN_LAYOUT");
  url.searchParams.set("subsec", "REQUEST_GET_SCHEME_EVENTS");

  for (const leagueId of leagueIds) {
    url.searchParams.append("league_id[]", leagueId);
  }

  url.searchParams.set("layout_schema_code", layoutSchemaCode);
  url.searchParams.set("start", "");
  url.searchParams.set("end", "");
  url.searchParams.set("selected_date_period", "null");

  return url.toString();
}

function parseRecords(html) {
  const records = [];
  const revRegex = /\brev="([^"]+)"/g;
  let match;

  while ((match = revRegex.exec(html)) !== null) {
    const decoded = decodeHtmlEntities(match[1]);

    if (!decoded.startsWith("{") || !decoded.endsWith("}")) {
      continue;
    }

    try {
      const obj = JSON.parse(decoded);

      // Bahis/maç kaydı olan rev objeleri.
      if (obj && obj.mid) {
        records.push(obj);
      }
    } catch {
      // rev her zaman bahis JSON'u olmak zorunda değil; parse edilemeyeni geç.
    }
  }

  return records;
}

function uniqueByOutcomeId(records) {
  const map = new Map();

  for (const record of records) {
    const key =
      record.oid ||
      `${record.mid || ""}:${record.market_id || ""}:${record.beton || ""}:${
        record.odds || ""
      }`;

    if (!map.has(key)) {
      map.set(key, record);
    }
  }

  return [...map.values()];
}

function chunkArray(items, size) {
  const chunks = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

async function fetchSport(sport, menuInfo) {
  const allLeagueIds = menuInfo.leagueIds;

  if (!allLeagueIds.length) {
    console.log(`\n========== ${sport.name} ==========`);
    console.log("Bu spor için lig bulunamadı.");
    return;
  }

  const selectedLeagueIds =
    LEAGUE_MODE === "all" ? allLeagueIds : allLeagueIds.slice(0, 10);

  const groups = chunkArray(selectedLeagueIds, CHUNK_SIZE);
  const allRecords = [];

  for (let i = 0; i < groups.length; i++) {
    const leagueIds = groups[i];
    const url = buildEventsUrl(leagueIds, menuInfo.layoutSchemaCode);

    const response = await get(url, {
      Referer: HOME_URL,
      "X-Requested-With": "XMLHttpRequest",
    });

    allRecords.push(...parseRecords(response.body));
  }

  const records = uniqueByOutcomeId(allRecords);
  const eventIds = [...new Set(records.map((x) => String(x.mid)))];

  const result = {
    source: "BETIST",
    sport: sport.name,
    sportId: sport.sportId,
    layoutSchemaCode: menuInfo.layoutSchemaCode,
    leagueCount: selectedLeagueIds.length,
    leagueIds: selectedLeagueIds,
    eventCount: eventIds.length,
    eventIds,
    recordCount: records.length,
    records,
  };

  console.log("");
  console.log("##############################################");
  console.log(`############### ${sport.name} ###############`);
  console.log("##############################################");
  console.log("");

  // depth: 1 => records içindekileri [Object] şeklinde gösterir.
  console.dir(result, {
    depth: 1,
    colors: true,
    maxArrayLength: null,
  });

  console.log("");
  console.log("----------------------------------------------");
}

async function main() {
  console.log("Betist ana sayfası çekiliyor...");

  const homeResponse = await get(HOME_URL, {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    Referer: "https://betist2103.com/betting",
  });

  const menu = parseSportMenu(homeResponse.body);

  if (!menu.length) {
    throw new Error(
      "Spor menüsü bulunamadı. Site HTML yapısını değiştirmiş veya anti-bot sayfası dönmüş olabilir."
    );
  }

  console.log(`Spor menüsü bulundu: ${menu.length} spor.`);
  console.log(
    `Lig modu: ${LEAGUE_MODE === "all" ? "TÜM LİGLER" : "İLK 10 LİG"}`
  );

  for (const sport of TARGET_SPORTS) {
    const menuInfo = menu.find((item) => item.sportId === sport.sportId);

    if (!menuInfo) {
      console.log(`\n${sport.name}: sportId=${sport.sportId} bulunamadı.`);
      continue;
    }

    try {
      await fetchSport(sport, menuInfo);
    } catch (error) {
      console.error(`\n${sport.name} çekilirken hata:`, error.message);
    }
  }
}

main().catch((error) => {
  console.error("\nFatal error:", error);
  process.exitCode = 1;
});
