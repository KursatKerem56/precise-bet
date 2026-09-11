import WebSocket from "ws";
import crypto from "crypto";

/*
|--------------------------------------------------------------------------
| MAVIBET AYARLARI
|--------------------------------------------------------------------------
|
| Site numarası değişirse sadece MAVIBET_NUMBER değerini değiştirmen yeterli.
| Örn: 1005 -> 1006
|
*/

const MAVIBET_NUMBER = process.env.MAVIBET_NUMBER || "1005";

const MAVIBET_BASE =
  process.env.MAVIBET_BASE || `https://www.mavibet${MAVIBET_NUMBER}.com`;

const WS_URL =
  process.env.WS_URL || `wss://sportsapi.mavibet${MAVIBET_NUMBER}.com/v2`;

/*
|--------------------------------------------------------------------------
| SÜPER LİG
|--------------------------------------------------------------------------
|
| HAR / WebSocket incelemesinde görülen bilgiler:
|
| sportId      = 1
| venueId      = 221
| tournamentId = 308741236357558272
|
*/

const SUPER_LIG = {
  name: "TÜRKİYE SÜPER LİG",
  sportId: "1",
  venueId: "221",
  tournamentId: "308741236357558272",
};

/*
|--------------------------------------------------------------------------
| SPORLAR
|--------------------------------------------------------------------------
*/

const sports = [
  {
    name: "FUTBOL",
    sportId: 1,
    topic:
      "/sports/2007/tr/next-matches-aggregator-groups-overview/1/20/2258,2259,2260",
  },
  {
    name: "BASKETBOL",
    sportId: 8,
    topic: "/sports/2007/tr/next-matches-aggregator-groups-overview/8/10/2390",
  },
  {
    name: "TENIS",
    sportId: 3,
    topic: "/sports/2007/tr/next-matches-aggregator-groups-overview/3/10/2384",
  },
  {
    name: "VOLEYBOL",
    sportId: 20,
    topic:
      "/sports/2007/tr/next-matches-aggregator-groups-overview/20/10/2424,2425",
  },
  {
    name: "BEYZBOL",
    sportId: 9,
    topic:
      "/sports/2007/tr/next-matches-aggregator-groups-overview/9/10/2417,2418",
  },
];

/*
|--------------------------------------------------------------------------
| TARİH / SAAT
|--------------------------------------------------------------------------
|
| Mavibet startTime değerleri milisaniye cinsinden Unix timestamp.
| Ekranda gördüğümüz saat Türkiye saati olduğu için Europe/Istanbul kullanıyoruz.
|
*/

function formatIstanbulDateTime(startTime) {
  const date = new Date(Number(startTime));

  if (Number.isNaN(date.getTime())) {
    return {
      date: null,
      time: null,
    };
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/*
|--------------------------------------------------------------------------
| MAVIBET MAÇLARINI ORTAK FORMATA ÇEVİR
|--------------------------------------------------------------------------
*/

function extractMavibetMatches(records) {
  if (!Array.isArray(records)) {
    return [];
  }

  return records
    .filter((record) => record && record._type === "MATCH")
    .map((record) => {
      const { date, time } = formatIstanbulDateTime(record.startTime);

      return {
        source: "MAVIBET",
        sport: record.sportName || "Futbol",

        leagueId: record.parentId != null ? String(record.parentId) : null,

        leagueName: record.shortParentName || record.parentName || null,

        eventId: record.id != null ? String(record.id) : null,

        date,
        time,

        startTime: record.startTime != null ? Number(record.startTime) : null,

        home: record.homeParticipantName || null,

        away: record.awayParticipantName || null,

        venueId: record.venueId != null ? String(record.venueId) : null,

        venueName: record.venueName || null,
      };
    });
}

/*
|--------------------------------------------------------------------------
| WEBSOCKET
|--------------------------------------------------------------------------
*/

function connectSport(sport, index) {
  const clientId = crypto.randomBytes(32).toString("base64");

  const ws = new WebSocket(WS_URL, {
    origin: MAVIBET_BASE,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36",
    },
  });

  let rpcId = 10;
  const subscriptionId = 26;

  /*
   * Sadece FUTBOL bağlantısında kullanılacak.
   * Bu ID sayesinde popularMatches cevabını
   * başka cevaplardan ayırıyoruz.
   */
  let superLigRequestId = null;

  const context = () => ({
    v: "2",
    lang: "tr",
    tz: -180,
    cid: clientId,
    t: Math.floor(Date.now() / 1000),
  });

  const sendRpc = (id, path, details = {}) => {
    ws.send(
      JSON.stringify([
        48,
        id,
        {},
        path,
        [],
        {
          ...details,
          ctx: context(),
        },
      ])
    );
  };

  ws.on("open", function open() {
    console.log("");
    console.log("==============================================");
    console.log(`[${sport.name}] Connected to the WebSocket server.`);
    console.log("==============================================");

    /*
     * Eski çalışan bağlantı başlangıcı.
     */
    ws.send(JSON.stringify([1, "http://www.mavibet.com"]));

    sendRpc(rpcId++, "/sports#disciplines", {
      lang: "tr",
      sportId: sport.sportId,
    });

    sendRpc(rpcId++, "/sports#locations", {
      lang: "tr",
      sportId: sport.sportId,
      venueId: 0,
    });

    sendRpc(rpcId++, "/sports#getSessionInfo", {
      lang: "tr",
    });

    sendRpc(rpcId++, "/sports#configureFonts", {});

    sendRpc(rpcId++, "/sports#initialDump", {
      topic: "/sports/2007/tr/disciplinesV2/BOTH/BOTH",
    });

    const today = new Date();

    const startOfDay = new Date(today);

    startOfDay.setHours(0, 0, 0, 0);

    const endOfWindow = new Date(startOfDay);

    endOfWindow.setDate(endOfWindow.getDate() + 7);

    sendRpc(rpcId++, "/sports#sportsDataInfo", {
      lang: "tr",
      sportId: String(sport.sportId),

      epochSecondsStartDate: Math.floor(startOfDay.getTime() / 1000),

      epochSecondsStopDate: Math.floor(endOfWindow.getTime() / 1000) - 1,

      userTimezoneOffsetInMinutes: 180,
    });

    sendRpc(rpcId++, "/sports#marketGroupsOverview", {
      lang: "tr",
      sportId: String(sport.sportId),
      liveStatus: "NOT_LIVE",
    });

    /*
     * Genel spor topic aboneliği.
     */
    ws.send(JSON.stringify([64, subscriptionId, {}, sport.topic]));

    const initialDumpRequestId = rpcId++;

    sendRpc(initialDumpRequestId, "/sports#initialDump", {
      topic: sport.topic,
    });

    console.log(`[${sport.name}] Sent sports initial-data request.`);

    console.log(`[${sport.name}] Request ID: ${initialDumpRequestId}`);

    console.log(`[${sport.name}] Topic: ${sport.topic}`);

    /*
     * SADECE FUTBOL:
     *
     * Süper Lig için sayfanın kullandığı
     * /sports#popularMatches çağrısını gönderiyoruz.
     *
     * Tarayıcı 6 istiyor.
     * Biz maxResults=100 ile sunucunun kaç maç
     * döndürdüğünü test ediyoruz.
     */
    if (sport.name === "FUTBOL") {
      superLigRequestId = rpcId++;

      sendRpc(superLigRequestId, "/sports#popularMatches", {
        lang: "tr",
        sportId: SUPER_LIG.sportId,
        venueId: SUPER_LIG.venueId,
        tournamentId: SUPER_LIG.tournamentId,
        maxResults: 100,
      });

      console.log("");
      console.log(`[FUTBOL] ${SUPER_LIG.name} isteği gönderildi.`);

      console.log(`[FUTBOL] Süper Lig request ID: ${superLigRequestId}`);

      console.log(`[FUTBOL] tournamentId: ${SUPER_LIG.tournamentId}`);
    }
  });

  ws.on("message", function incoming(raw) {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      console.error(`[${sport.name}] JSON parse error:`, error);
      return;
    }

    const data = message[4];

    /*
     * ==============================================================
     * SÜPER LİG popularMatches CEVABI
     * ==============================================================
     *
     * İstek:
     * [48, requestId, ...]
     *
     * Cevap:
     * [50, requestId, {}, [], { records: [...] }]
     *
     */
    if (
      sport.name === "FUTBOL" &&
      superLigRequestId !== null &&
      message[0] === 50 &&
      message[1] === superLigRequestId &&
      data &&
      Array.isArray(data.records)
    ) {
      const rawMatches = data.records.filter(
        (record) => record && record._type === "MATCH"
      );

      const matches = extractMavibetMatches(data.records);

      console.log("");
      console.log("");
      console.log(
        "============================================================"
      );

      console.log("MAVIBET - TÜRKİYE SÜPER LİG");

      console.log(
        "============================================================"
      );

      console.log(`Gelen toplam record: ${data.records.length}`);

      console.log(`Maç sayısı: ${rawMatches.length}`);

      console.log("");
      console.log("NORMALIZE EDİLMİŞ MAÇLAR:");

      console.dir(matches, {
        depth: null,
        colors: true,
        maxArrayLength: null,
      });

      console.log("");
      console.log("RAW MATCH RECORDS:");

      console.dir(rawMatches, {
        depth: null,
        colors: true,
        maxArrayLength: null,
      });

      console.log(
        "============================================================"
      );

      return;
    }

    /*
     * Diğer INITIAL_DUMP cevaplarını artık
     * büyük obje olarak basmıyoruz.
     *
     * Sadece geldiğini görmek için kısa bilgi.
     */
    if (
      data &&
      typeof data === "object" &&
      data.messageType === "INITIAL_DUMP"
    ) {
      const count = Array.isArray(data.records) ? data.records.length : 0;

      console.log(`[${sport.name}] INITIAL_DUMP geldi. Record: ${count}`);
    }
  });

  ws.on("close", function close(code, reason) {
    console.log(`[${sport.name}] Disconnected (${code}): ${reason.toString()}`);
  });

  ws.on("error", function error(err) {
    console.error(`[${sport.name}] WebSocket error:`, err);
  });
}

/*
|--------------------------------------------------------------------------
| BAŞLAT
|--------------------------------------------------------------------------
*/

console.log(`Mavibet site: ${MAVIBET_BASE}`);

console.log(`Mavibet WS: ${WS_URL}`);

sports.forEach((sport, index) => {
  setTimeout(() => {
    connectSport(sport, index);
  }, index * 750);
});
