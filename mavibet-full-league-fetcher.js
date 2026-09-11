import WebSocket from "ws";
import crypto from "crypto";
const MAVIBET_NUMBER = process.env.MAVIBET_NUMBER || "1005";
const MAVIBET_SPORTS_ORIGIN =
  process.env.MAVIBET_SPORTS_ORIGIN ||
  `https://sports2.mavibet${MAVIBET_NUMBER}.com`;

const MAVIBET_BASE =
  process.env.MAVIBET_BASE || `https://www.mavibet${MAVIBET_NUMBER}.com`;

const WS_URL =
  process.env.WS_URL || `wss://sportsapi.mavibet${MAVIBET_NUMBER}.com/v2`;

const SUPER_LIG = {
  sportId: "1",
  venueId: "221",
  tournamentId: "308741236357558272",
  name: "Türkiye Süper Lig",
};

const cid = crypto.randomBytes(32).toString("base64");

const ctx = () => ({
  v: "2",
  lang: "tr",
  tz: -180,
  cid,
  t: Math.floor(Date.now() / 1000),
});

function formatDateTime(startTime) {
  const d = new Date(Number(startTime));

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

function extractMatches(records) {
  return (Array.isArray(records) ? records : [])
    .filter(
      (r) =>
        r &&
        r._type === "MATCH" &&
        String(r.parentId) === SUPER_LIG.tournamentId
    )
    .map((r) => {
      const dt = formatDateTime(r.startTime);

      return {
        source: "MAVIBET",
        sport: "FUTBOL",

        leagueId: String(r.parentId),

        leagueName: r.shortParentName || r.parentName || SUPER_LIG.name,

        eventId: String(r.id),

        date: dt.date,
        time: dt.time,

        startTime: Number(r.startTime),

        home: r.homeParticipantName,

        away: r.awayParticipantName,
      };
    });
}

function sevenDayWindow() {
  const start = new Date();

  start.setHours(0, 0, 0, 0);

  const stop = new Date(start);

  stop.setDate(stop.getDate() + 7);

  return {
    start: Math.floor(start.getTime() / 1000),

    stop: Math.floor(stop.getTime() / 1000) - 1,
  };
}

const ws = new WebSocket(WS_URL, "wamp.2.json", {
  origin: MAVIBET_SPORTS_ORIGIN,

  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  },
});

/*
|--------------------------------------------------------------------------
| TEK GLOBAL REQUEST ID SAYACI
|--------------------------------------------------------------------------
|
| 1  = SUBSCRIBE
| 2-7 = REGISTER
| 8-9 = CALL
| ardından her yeni request gönderildiği anda +1
|
*/

let nextRequestId = 1;

function nextId() {
  return nextRequestId++;
}

function send(frame) {
  ws.send(JSON.stringify(frame));
}

function subscribe(topic) {
  const id = nextId();

  send([32, id, {}, topic]);

  console.log(`SEND SUBSCRIBE ${id} -> ${topic}`);

  return id;
}

function register(procedure) {
  const id = nextId();

  send([64, id, {}, procedure]);

  console.log(`SEND REGISTER ${id} -> ${procedure}`);

  return id;
}

function call(path, details = {}) {
  const id = nextId();

  send([
    48,
    id,
    {},
    path,
    [],
    {
      ...details,
      ctx: ctx(),
    },
  ]);

  console.log(`SEND CALL ${id} -> ${path}`);

  return id;
}

function initialDump(topic) {
  return call("/sports#initialDump", {
    topic,
  });
}

/*
|--------------------------------------------------------------------------
| STATE
|--------------------------------------------------------------------------
*/

const baseRegistrationTopics = new Map();
const baseDumpIds = new Set();
const completedBaseDumps = new Set();

let marketNotLiveId = null;
let marketLiveId = null;

let popularRegistrationId = null;
let liveRegistrationId = null;

let popularDumpId = null;
let liveDumpId = null;

const homepageFinished = new Set();

let tournamentRegistrationId = null;
let tournamentDumpId = null;

let tournamentCall1Id = null;
let tournamentCall2Id = null;
let disciplineCallId = null;

let sportsDataInfoId = null;
let secondMarketGroupsId = null;

let leagueRegistrationId = null;
let leagueDumpId = null;

let leagueTopic = null;

let tournamentFlowStarted = false;
let finished = false;

/*
|--------------------------------------------------------------------------
| BASE
|--------------------------------------------------------------------------
*/

function startBase() {
  subscribe("/registrationDismissed");

  const topics = [
    "/sports/2007/tr/disciplines/LIVE/NOT_VIRTUAL",
    "/sports/2007/tr/custom-events",
    "/sports/2007/tr/custom-sports",
    "/sports/2007/tr/disciplines/BOTH/BOTH",
    "/sports/2007/tr/disciplinesV2/BOTH/BOTH",
    "/sports/2007/tr/disciplines/NOT_LIVE/NOT_VIRTUAL",
  ];

  for (const topic of topics) {
    const id = register(topic);

    baseRegistrationTopics.set(id, topic);
  }

  call("/sports#getSessionInfo", {
    lang: "tr",
  });

  call("/sports#configureFonts", {});
}

function startMarketPhase() {
  console.log("");
  console.log("=== MARKET PHASE ===");

  marketNotLiveId = call("/sports#marketGroupsOverview", {
    lang: "tr",
    sportId: "1",
    liveStatus: "NOT_LIVE",
  });

  marketLiveId = call("/sports#marketGroupsOverview", {
    lang: "tr",
    sportId: "1",
    liveStatus: "LIVE",
  });
}

function markHomepageFinished(id) {
  homepageFinished.add(id);

  if (homepageFinished.size >= 2) {
    startTournamentFlow();
  }
}

/*
|--------------------------------------------------------------------------
| TOURNAMENT FLOW
|--------------------------------------------------------------------------
*/

function startTournamentFlow() {
  if (tournamentFlowStarted) {
    return;
  }

  tournamentFlowStarted = true;

  console.log("");
  console.log("==============================================");
  console.log("TURNUVA AKIŞI BAŞLIYOR");
  console.log("==============================================");

  tournamentRegistrationId = register("/sports/2007/tr/tournaments/1/221");

  tournamentCall1Id = call("/sports#tournaments", {
    tournamentId: SUPER_LIG.tournamentId,
    lang: "tr",
  });

  tournamentCall2Id = call("/sports#tournaments", {
    lang: "tr",
    tournamentId: SUPER_LIG.tournamentId,
  });

  disciplineCallId = call("/sports#disciplines", {
    lang: "tr",
    sportId: 1,
  });
}

/*
|--------------------------------------------------------------------------
| OPEN
|--------------------------------------------------------------------------
*/

ws.on("open", () => {
  console.log(`Mavibet site: ${MAVIBET_BASE}`);

  console.log(`Mavibet WS: ${WS_URL}`);

  console.log("WebSocket bağlandı.");

  send([
    1,
    "http://www.mavibet.com",
    {
      agent: "Wampy.js v6.2.2",

      roles: {
        publisher: {
          features: {
            subscriber_blackwhite_listing: true,
            publisher_exclusion: true,
            publisher_identification: true,
          },
        },

        subscriber: {
          features: {
            pattern_based_subscription: true,
            publication_trustlevels: true,
          },
        },

        caller: {
          features: {
            caller_identification: true,
            progressive_call_results: true,
            call_canceling: true,
            call_timeout: true,
          },
        },

        callee: {
          features: {
            caller_identification: true,
            call_trustlevels: true,
            pattern_based_registration: true,
            shared_registration: true,
          },
        },
      },

      authmethods: ["wampcra"],

      authid: "webapi-wampy",
    },
  ]);
});

/*
|--------------------------------------------------------------------------
| MESSAGE
|--------------------------------------------------------------------------
*/

ws.on("message", (raw) => {
  let m;

  try {
    m = JSON.parse(raw.toString());
  } catch (error) {
    console.error("JSON parse error:", error);

    return;
  }

  if (!Array.isArray(m)) {
    return;
  }

  const type = m[0];

  /*
   * WELCOME
   */
  if (type === 2) {
    console.log(`WAMP WELCOME. Session: ${m[1]}`);

    startBase();
    return;
  }

  /*
   * SERVER INVOCATION
   */
  if (type === 68) {
    send([70, m[1], {}]);

    return;
  }

  /*
   * REGISTERED
   */
  if (type === 65) {
    const requestId = m[1];

    /*
     * Base REGISTER cevapları hangi sırada gelirse gelsin,
     * initialDump ID'sini ŞİMDİ alıyoruz.
     *
     * Böylece browser gibi:
     * 10,11,12,13,14,15
     * sırasıyla gönderilecek.
     */
    if (baseRegistrationTopics.has(requestId)) {
      const topic = baseRegistrationTopics.get(requestId);

      const dumpId = initialDump(topic);

      baseDumpIds.add(dumpId);

      return;
    }

    /*
     * Popular registration.
     */
    if (requestId === popularRegistrationId) {
      popularDumpId = initialDump(
        "/sports/2007/tr/popular-matches-aggregator-groups-overview/1/20/2875,2876,2877"
      );

      return;
    }

    /*
     * Live registration.
     */
    if (requestId === liveRegistrationId) {
      liveDumpId = initialDump(
        "/sports/2007/tr/live-matches-aggregator-groups-overview/1/all-locations/default-event-info/10/2875,2876,2877"
      );

      return;
    }

    /*
     * Tournament registration.
     */
    if (requestId === tournamentRegistrationId) {
      console.log(`Türkiye tournament REGISTERED: ${requestId}`);

      tournamentDumpId = initialDump("/sports/2007/tr/tournaments/1/221");

      return;
    }

    /*
     * Süper Lig registration.
     */
    if (requestId === leagueRegistrationId) {
      console.log(`Süper Lig REGISTERED: ${requestId}`);

      leagueDumpId = initialDump(leagueTopic);

      console.log(`Süper Lig full dump istendi. ID: ${leagueDumpId}`);

      return;
    }

    return;
  }

  /*
   * WAMP ERROR
   */
  if (type === 8) {
    const requestType = m[1];

    const requestId = m[2];

    console.error("");
    console.error("******** WAMP ERROR ********");

    console.error(`Request type: ${requestType}`);

    console.error(`Request ID: ${requestId}`);

    console.dir(m, {
      depth: null,
      colors: true,
    });

    /*
     * 20 / 21 hata verse bile
     * Süper Lig akışına devam et.
     */
    if (requestId === popularDumpId || requestId === liveDumpId) {
      console.log(
        `Homepage dump ${requestId} hata verdi; teste devam ediyoruz.`
      );

      markHomepageFinished(requestId);
    }

    /*
     * Asıl 30 hata verirse testi bitir.
     */
    if (requestId === leagueDumpId) {
      console.log("");
      console.log("Süper Lig full dump isteği sunucu tarafından reddedildi.");

      finished = true;

      setTimeout(() => ws.close(), 500);
    }

    return;
  }

  /*
   * RESULT
   */
  if (type !== 50) {
    return;
  }

  const id = m[1];

  const data = m[4];

  /*
   * Base dumps.
   */
  if (baseDumpIds.has(id)) {
    completedBaseDumps.add(id);

    console.log(`Base dump geldi: ${id} (${completedBaseDumps.size}/6)`);

    if (completedBaseDumps.size === 6) {
      console.log("Base başlangıç tamamlandı.");

      startMarketPhase();
    }

    return;
  }

  /*
   * İlk NOT_LIVE market groups.
   */
  if (id === marketNotLiveId && Array.isArray(data?.response)) {
    console.log(`NOT_LIVE market groups geldi: ${id}`);

    popularRegistrationId = register(
      "/sports/2007/tr/popular-matches-aggregator-groups-overview/1/20/2875,2876,2877"
    );

    return;
  }

  /*
   * İlk LIVE market groups.
   */
  if (id === marketLiveId && Array.isArray(data?.response)) {
    console.log(`LIVE market groups geldi: ${id}`);

    liveRegistrationId = register(
      "/sports/2007/tr/live-matches-aggregator-groups-overview/1/all-locations/default-event-info/10/2875,2876,2877"
    );

    return;
  }

  /*
   * Popular/live initialDump.
   */
  if (id === popularDumpId || id === liveDumpId) {
    console.log(`Homepage initialDump başarılı: ${id}`);

    markHomepageFinished(id);

    return;
  }

  /*
   * Yardımcı tournament responses.
   */
  if (
    id === tournamentCall1Id ||
    id === tournamentCall2Id ||
    id === disciplineCallId
  ) {
    console.log(`Ara response geldi: ${id}`);

    return;
  }

  /*
   * Tournament dump.
   */
  if (id === tournamentDumpId && Array.isArray(data?.records)) {
    const tournaments = data.records.filter(
      (r) => r && r._type === "TOURNAMENT"
    );

    const superLig = tournaments.find(
      (r) => String(r.id) === SUPER_LIG.tournamentId
    );

    console.log("");
    console.log(`Tournament dump geldi: ${id}`);

    if (superLig) {
      console.log(`Süper Lig: ${superLig.name}`);

      console.log(`Yaklaşan maç: ${superLig.numberOfUpcomingMatches}`);
    }

    const window = sevenDayWindow();

    sportsDataInfoId = call("/sports#sportsDataInfo", {
      lang: "tr",
      sportId: "1",

      epochSecondsStartDate: window.start,

      epochSecondsStopDate: window.stop,

      userTimezoneOffsetInMinutes: 180,
    });

    return;
  }

  /*
   * Sports data info.
   */
  if (id === sportsDataInfoId) {
    console.log(`sportsDataInfo geldi: ${id}`);

    secondMarketGroupsId = call("/sports#marketGroupsOverview", {
      lang: "tr",
      sportId: "1",
      liveStatus: "NOT_LIVE",
    });

    return;
  }

  /*
   * League market groups.
   */
  if (id === secondMarketGroupsId && Array.isArray(data?.response)) {
    const ids = data.response
      .filter((x) => x && x._type === "MARKET_GROUP_OVERVIEW" && x.id != null)
      .sort((a, b) => Number(a.position ?? 999) - Number(b.position ?? 999))
      .map((x) => String(x.id));

    console.log(`Market groups: ${ids.join(", ")}`);

    leagueTopic =
      `/sports/2007/tr/tournament-aggregator-groups-overview/` +
      `${SUPER_LIG.tournamentId}/` +
      `default-event-info/NOT_LIVE/` +
      ids.slice(0, 3).join(",");

    console.log(`Süper Lig topic: ${leagueTopic}`);

    leagueRegistrationId = register(leagueTopic);

    return;
  }

  /*
   * FULL LEAGUE DUMP
   */
  if (id === leagueDumpId && Array.isArray(data?.records)) {
    const matches = extractMatches(data.records);

    finished = true;

    console.log("");
    console.log("============================================================");
    console.log("MAVIBET - TÜRKİYE SÜPER LİG - FULL DUMP");
    console.log("============================================================");

    console.log(`Response ID: ${id}`);

    console.log(`Format: ${data.format ?? "-"}`);

    console.log(`Message Type: ${data.messageType ?? "-"}`);

    console.log(`Toplam record: ${data.records.length}`);

    console.log(`MATCH sayısı: ${matches.length}`);

    console.log("");

    console.dir(matches, {
      depth: null,
      colors: true,
      maxArrayLength: null,
    });

    console.log("============================================================");

    setTimeout(() => ws.close(), 500);

    return;
  }
});

ws.on("error", (error) => {
  console.error("WebSocket error:", error);
});

ws.on("close", (code, reason) => {
  console.log(`WebSocket kapandı (${code}): ${reason.toString()}`);
});

setTimeout(() => {
  if (!finished) {
    console.log("");
    console.log("UYARI: 30 saniye içinde test tamamlanmadı.");

    ws.close();
  }
}, 30000);
