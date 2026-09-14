import fs from "node:fs/promises";
import https from "node:https";

const SITE_URL = process.env.BETIST_SITE_URL || "https://betist2105.com";

const BASE_URL = process.env.BETIST_BASE_URL || "https://bet.betist2105.com";

const HOME_URL = `${BASE_URL}/home.php?domain=&options=`;

const OUTPUT_FILE = process.env.BETIST_OUTPUT || "betist-matches.json";

const CHUNK_SIZE = Number(process.env.BETIST_CHUNK_SIZE || 10);

const REQUEST_DELAY_MS = Number(process.env.BETIST_REQUEST_DELAY_MS || 120);

const TARGET_ORDER = ["FUTBOL", "BASKETBOL", "VOLEYBOL", "TENIS"];

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",

  Accept: "*/*",

  "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",

  Connection: "keep-alive",
};

const cookieJar = new Map();

function updateCookies(setCookieHeaders = []) {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders].filter(Boolean);

  for (const line of list) {
    const firstPart = String(line).split(";", 1)[0];

    const eq = firstPart.indexOf("=");

    if (eq <= 0) {
      continue;
    }

    cookieJar.set(
      firstPart.slice(0, eq).trim(),

      firstPart.slice(eq + 1).trim()
    );
  }
}

function cookieHeader() {
  return [...cookieJar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function get(url, extraHeaders = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const cookies = cookieHeader();

    const headers = {
      ...COMMON_HEADERS,
      ...extraHeaders,

      ...(cookies
        ? {
            Cookie: cookies,
          }
        : {}),
    };

    const req = https.get(
      url,
      {
        headers,
      },
      (res) => {
        updateCookies(res.headers["set-cookie"] || []);

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

        res.on("data", (chunk) => {
          chunks.push(chunk);
        });

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

    req.setTimeout(25000, () => {
      req.destroy(new Error("Request timeout."));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
}

function stripTags(value) {
  return decodeHtmlEntities(
    String(value)
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function parseAttributes(tag) {
  const attrs = {};

  const regex = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;

  let match;

  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[3]);
  }

  return attrs;
}

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalSportName(menuName) {
  const n = normalizeText(menuName);

  if (n === "futbol" || n === "soccer") {
    return "FUTBOL";
  }

  if (n === "basketbol" || n === "basketball") {
    return "BASKETBOL";
  }

  if (n === "voleybol" || n === "volleyball") {
    return "VOLEYBOL";
  }

  if (n === "tenis" || n === "tennis") {
    return "TENIS";
  }

  return null;
}

function parseSportMenu(html) {
  const sportMarkers = [];

  const iTagRegex = /<i\b[^>]*>/gi;

  let tagMatch;

  while ((tagMatch = iTagRegex.exec(html)) !== null) {
    const attrs = parseAttributes(tagMatch[0]);

    const idMatch = String(attrs.id || "").match(/^check__(\d+)$/);

    if (!idMatch) {
      continue;
    }

    const classes = new Set(
      String(attrs.class || "")
        .split(/\s+/)
        .filter(Boolean)
    );

    if (!classes.has("b-check") || !classes.has("sport")) {
      continue;
    }

    const after = html.slice(iTagRegex.lastIndex, iTagRegex.lastIndex + 2000);

    const nameMatch = after.match(
      /<span\b[^>]*class=["'][^"']*\bsport-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
    );

    sportMarkers.push({
      sportId: idMatch[1],

      name: nameMatch ? stripTags(nameMatch[1]) : `SPORT_${idMatch[1]}`,

      layoutSchemaCode: attrs.layout || "",

      start: tagMatch.index,
    });
  }

  return sportMarkers.map((sport, index) => {
    const end =
      index + 1 < sportMarkers.length
        ? sportMarkers[index + 1].start
        : html.length;

    const block = html.slice(sport.start, end);

    const leagueIds = [];

    const seen = new Set();

    const tagRegex = /<i\b[^>]*>/gi;

    let match;

    while ((match = tagRegex.exec(block)) !== null) {
      const attrs = parseAttributes(match[0]);

      const idMatch = String(attrs.id || "").match(/^check__(\d+)$/);

      if (!idMatch) {
        continue;
      }

      const classes = new Set(
        String(attrs.class || "")
          .split(/\s+/)
          .filter(Boolean)
      );

      if (!classes.has("b-check") || !classes.has("stage")) {
        continue;
      }

      const id = idMatch[1];

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

function parseEventRecords(html) {
  const events = new Map();

  const revRegex = /\brev="([^"]+)"/g;

  let match;

  while ((match = revRegex.exec(html)) !== null) {
    const decoded = decodeHtmlEntities(match[1]);

    if (!decoded.startsWith("{") || !decoded.endsWith("}")) {
      continue;
    }

    try {
      const obj = JSON.parse(decoded);

      if (!obj?.mid || !obj?.event_start_time || !obj?.lid) {
        continue;
      }

      const key = String(obj.mid);

      if (!events.has(key)) {
        events.set(key, obj);
      }
    } catch {
      // rev attribute her zaman
      // event JSON'u olmayabilir.
    }
  }

  return [...events.values()];
}

function splitParticipants(eventName) {
  const value = String(eventName || "").trim();

  const separator = " - ";

  const index = value.indexOf(separator);

  if (index === -1) {
    return {
      home: value,
      away: "",
    };
  }

  return {
    home: value.slice(0, index).trim(),

    away: value.slice(index + separator.length).trim(),
  };
}

function parseStartTime(value) {
  const match = String(value || "").match(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::\d{2})?$/
  );

  if (!match) {
    return {
      date: "UNKNOWN_DATE",

      time: "",
    };
  }

  return {
    date: match[1],

    time: match[2],
  };
}

function chunkArray(items, size) {
  const chunks = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

async function fetchAllEventsForSport(menuInfo, canonicalName) {
  const groups = chunkArray(menuInfo.leagueIds, CHUNK_SIZE);

  const events = new Map();

  console.log(
    `${canonicalName}: sportId=${menuInfo.sportId}, lig=${menuInfo.leagueIds.length}, layout=${menuInfo.layoutSchemaCode}`
  );

  for (let i = 0; i < groups.length; i++) {
    const leagueIds = groups[i];

    const url = buildEventsUrl(leagueIds, menuInfo.layoutSchemaCode);

    console.log(`  grup ${i + 1}/${groups.length} -> ${leagueIds.length} lig`);

    const response = await get(url, {
      Referer: `${SITE_URL}/betting`,

      "X-Requested-With": "XMLHttpRequest",
    });

    for (const event of parseEventRecords(response.body)) {
      if (String(event.sport_id) !== String(menuInfo.sportId)) {
        continue;
      }

      events.set(String(event.mid), event);
    }

    if (REQUEST_DELAY_MS > 0 && i + 1 < groups.length) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log(`  benzersiz maç: ${events.size}`);

  return [...events.values()];
}

function addEventsToOutput(output, canonicalSport, events) {
  for (const event of events) {
    const leagueName = String(event.league_name || `LIG_${event.lid}`).trim();

    const countryName = String(event.country_name || "").trim();

    const leagueKey = countryName
      ? `${countryName} - ${leagueName}`
      : leagueName;

    const { date, time } = parseStartTime(event.event_start_time);

    const { home, away } = splitParticipants(event.event);

    output[canonicalSport][leagueKey] ??= {};

    output[canonicalSport][leagueKey][date] ??= [];

    output[canonicalSport][leagueKey][date].push({
      eventId: String(event.mid),

      leagueId: String(event.lid),

      home,
      away,
      time,
    });
  }
}

function sortOutput(output) {
  const sorted = {};

  for (const sport of TARGET_ORDER) {
    sorted[sport] = {};

    const leagueEntries = Object.entries(output[sport] || {}).sort(([a], [b]) =>
      a.localeCompare(b, "tr")
    );

    for (const [league, dates] of leagueEntries) {
      sorted[sport][league] = {};

      for (const date of Object.keys(dates).sort()) {
        sorted[sport][league][date] = dates[date].sort((a, b) => {
          const byTime = String(a.time).localeCompare(String(b.time));

          if (byTime !== 0) {
            return byTime;
          }

          return `${a.home}-${a.away}`.localeCompare(
            `${b.home}-${b.away}`,
            "tr"
          );
        });
      }
    }
  }

  return sorted;
}

async function main() {
  console.log(`Betist: ${SITE_URL}`);

  console.log(`Data host: ${BASE_URL}`);

  console.log("Spor/lig menüsü çekiliyor...");

  const homeResponse = await get(HOME_URL, {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

    Referer: `${SITE_URL}/betting`,
  });

  const menu = parseSportMenu(homeResponse.body);

  if (!menu.length) {
    throw new Error(
      "Spor menüsü bulunamadı. Site HTML yapısı değişmiş veya farklı bir sayfa dönmüş olabilir."
    );
  }

  const targetMenus = new Map();

  for (const item of menu) {
    const canonical = canonicalSportName(item.name);

    if (canonical && !targetMenus.has(canonical)) {
      targetMenus.set(canonical, item);
    }
  }

  const output = Object.fromEntries(TARGET_ORDER.map((sport) => [sport, {}]));

  for (const sport of TARGET_ORDER) {
    const menuInfo = targetMenus.get(sport);

    if (!menuInfo) {
      console.warn(`${sport}: menüde bulunamadı; boş bırakılıyor.`);

      continue;
    }

    if (!menuInfo.layoutSchemaCode) {
      console.warn(`${sport}: layout_schema_code bulunamadı; boş bırakılıyor.`);

      continue;
    }

    if (!menuInfo.leagueIds.length) {
      console.warn(`${sport}: lig bulunamadı; boş bırakılıyor.`);

      continue;
    }

    try {
      const events = await fetchAllEventsForSport(menuInfo, sport);

      addEventsToOutput(output, sport, events);
    } catch (error) {
      console.error(`${sport} çekilirken hata: ${error.message}`);
    }
  }

  const finalOutput = sortOutput(output);

  await fs.writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(finalOutput, null, 2)}\n`,
    "utf8"
  );

  console.log("");

  console.log(`JSON yazıldı: ${OUTPUT_FILE}`);

  for (const sport of TARGET_ORDER) {
    const leagues = Object.keys(finalOutput[sport]);

    const matchCount = leagues.reduce(
      (sum, league) =>
        sum +
        Object.values(finalOutput[sport][league]).reduce(
          (dateSum, matches) => dateSum + matches.length,
          0
        ),
      0
    );

    console.log(`${sport}: ${leagues.length} lig / ${matchCount} maç`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);

  process.exitCode = 1;
});
