const WebSocket = require("ws");

const pageUrl =
  process.env.PAGE_URL ||
  "https://www.mavibet998.com/sports/spor/futbol/1/tümü/0/lokasyon/yaklaşan-karşılaşmalar";
const wsUrl = process.env.WS_URL || "wss://sportsapi.mavibet998.com/v2";
const clientId =
  process.env.WS_CID || require("crypto").randomBytes(32).toString("base64");
const topic =
  process.env.WS_TOPIC ||
  "/sports/2007/tr/next-matches-aggregator-groups-overview/1/20/2258,2259,2260";
const ws = new WebSocket(wsUrl, {
  origin: new URL(pageUrl).origin,
  headers: {
    "User-Agent": "Mozilla/5.0",
  },
});

ws.on("open", function open() {
  console.log("Connected to the WebSocket server.");

  ws.send(JSON.stringify([1, "http://www.mavibet.com"]));

  const timestamp = Math.floor(Date.now() / 1000);
  const context = () => ({
    v: "2",
    lang: "tr",
    tz: -180,
    cid: clientId,
    t: timestamp,
  });
  const sendRpc = (id, path, details) =>
    ws.send(
      JSON.stringify([48, id, {}, path, [], { ...details, ctx: context() }]),
    );

  sendRpc(10, "/sports#disciplines", { lang: "tr", sportId: 1 });
  sendRpc(11, "/sports#locations", {
    lang: "tr",
    sportId: 1,
    venueId: 0,
  });
  sendRpc(12, "/sports#getSessionInfo", { lang: "tr" });
  sendRpc(13, "/sports#configureFonts", {});

  ["/sports/2007/tr/disciplinesV2/BOTH/BOTH"].forEach((initialTopic, index) => {
    sendRpc(14 + index, "/sports#initialDump", { topic: initialTopic });
  });

  const today = new Date();
  const startOfDay = new Date(today);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfWindow = new Date(startOfDay);
  endOfWindow.setDate(endOfWindow.getDate() + 7);
  sendRpc(22, "/sports#sportsDataInfo", {
    lang: "tr",
    sportId: "1",
    epochSecondsStartDate: Math.floor(startOfDay.getTime() / 1000),
    epochSecondsStopDate: Math.floor(endOfWindow.getTime() / 1000) - 1,
    userTimezoneOffsetInMinutes: 180,
  });
  sendRpc(23, "/sports#marketGroupsOverview", {
    lang: "tr",
    sportId: "1",
    liveStatus: "NOT_LIVE",
  });

  const subscription = [64, 26, {}, topic];
  ws.send(JSON.stringify(subscription));

  const request = [
    48,
    27,
    {},
    "/sports#initialDump",
    [],
    {
      topic,
      ctx: {
        v: "2",
        lang: "tr",
        tz: -180,
        cid: clientId,
        t: Math.floor(Date.now() / 1000),
      },
    },
  ];

  ws.send(JSON.stringify(request));
  console.log("Sent sports initial-data request.");
});

ws.on("message", function incoming(raw) {
  const message = JSON.parse(raw.toString());
  const data = message[4];
  if (data && data.messageType === "INITIAL_DUMP") {
    console.log("Received message:", message);
    console.log("------------------------------");
  }
});

ws.on("close", function close(code, reason) {
  console.log(
    `Disconnected from the WebSocket server (${code}): ${reason.toString()}`,
  );
});

ws.on("error", function error(err) {
  console.error("WebSocket error:", err);
});
