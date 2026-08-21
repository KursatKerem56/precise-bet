const WebSocket = require("ws");
const crypto = require("crypto");

const wsUrl = process.env.WS_URL || "wss://sportsapi.mavibet998.com/v2";

const sports = [
  {
    name: "FUTBOL",

    pageUrl:
      "https://www.mavibet998.com/sports/spor/futbol/1/tümü/0/lokasyon/yaklaşan-karşılaşmalar",

    sportId: 1,

    topic:
      "/sports/2007/tr/next-matches-aggregator-groups-overview/1/20/2258,2259,2260",
  },

  {
    name: "BASKETBOL",

    pageUrl:
      "https://www.mavibet998.com/sports/spor/basketbol/8/tümü/0/lokasyon/yaklaşan-karşılaşmalar",

    sportId: 8,

    topic: "/sports/2007/tr/next-matches-aggregator-groups-overview/8/10/2390",
  },

  {
    name: "TENIS",

    pageUrl:
      "https://www.mavibet998.com/sports/spor/tenis/3/tümü/0/lokasyon/yaklaşan-karşılaşmalar",

    sportId: 3,

    topic: "/sports/2007/tr/next-matches-aggregator-groups-overview/3/10/2384",
  },

  {
    name: "VOLEYBOL",

    pageUrl:
      "https://www.mavibet998.com/sports/spor/voleybol/20/tümü/0/lokasyon/yaklaşan-karşılaşmalar",

    sportId: 20,

    topic:
      "/sports/2007/tr/next-matches-aggregator-groups-overview/20/10/2424,2425",
  },

  {
    name: "BEYZBOL",

    pageUrl:
      "https://www.mavibet998.com/sports/spor/beyzbol/9/tümü/0/lokasyon/yaklaşan-karşılaşmalar",

    sportId: 9,

    topic:
      "/sports/2007/tr/next-matches-aggregator-groups-overview/9/10/2417,2418",
  },
];

function connectSport(sport, index) {
  const clientId = crypto.randomBytes(32).toString("base64");

  const ws = new WebSocket(wsUrl, {
    origin: new URL(sport.pageUrl).origin,

    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  let rpcId = 10;

  let subscriptionId = 26;

  const context = () => ({
    v: "2",
    lang: "tr",
    tz: -180,
    cid: clientId,
    t: Math.floor(Date.now() / 1000),
  });

  const sendRpc = (id, path, details) => {
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
      ]),
    );
  };

  ws.on(
    "open",

    function open() {
      console.log("");
      console.log("==============================================");

      console.log(`[${sport.name}] Connected to the WebSocket server.`);

      console.log("==============================================");

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

      const subscription = [64, subscriptionId, {}, sport.topic];

      ws.send(JSON.stringify(subscription));

      const requestId = rpcId++;

      const request = [
        48,
        requestId,
        {},
        "/sports#initialDump",
        [],
        {
          topic: sport.topic,

          ctx: context(),
        },
      ];

      ws.send(JSON.stringify(request));

      console.log(`[${sport.name}] Sent sports initial-data request.`);

      console.log(`[${sport.name}] Request ID: ${requestId}`);

      console.log(`[${sport.name}] Topic: ${sport.topic}`);
    },
  );

  ws.on(
    "message",

    function incoming(raw) {
      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        console.error(`[${sport.name}] JSON parse error:`, error);

        return;
      }

      const data = message[4];

      if (
        data &&
        typeof data === "object" &&
        data.messageType === "INITIAL_DUMP"
      ) {
        console.log("");
        console.log("");
        console.log("##################################################");

        console.log(`################ ${sport.name} ################`);

        console.log("##################################################");

        console.log("");

        console.log("Received message:", message);

        console.log("--------------------------------------------------");

        console.log("");
      }
    },
  );

  ws.on(
    "close",

    function close(code, reason) {
      console.log(
        `[${sport.name}] Disconnected (${code}): ${reason.toString()}`,
      );
    },
  );

  ws.on(
    "error",

    function error(err) {
      console.error(`[${sport.name}] WebSocket error:`, err);
    },
  );
}

sports.forEach((sport, index) => {
  setTimeout(
    () => {
      connectSport(sport, index);
    },

    index * 750,
  );
});
