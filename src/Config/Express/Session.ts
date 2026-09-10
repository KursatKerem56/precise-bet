import { Application } from "express";
import session from "express-session";

import { redisStore } from "@Config/Redis";
import config from "@Config/Environment";

const defaultCookie = {
  originalMaxAge: 60 * 120 * 1000 * 48,
  expires: new Date(Date.now() + 60 * 120 * 1000 * 48),
  httpOnly: true,
  path: "/",
};

const sessionConfig: session.SessionOptions = {
  secret: config.session.secret,
  store: redisStore,
  resave: false,
  proxy: true,
  saveUninitialized: false,
  name: "session",
  cookie: defaultCookie,
};

const setupSession = (app: Application) => {
  if (app.get("env") === "production") {
    if (!sessionConfig.cookie) sessionConfig.cookie = {};
    sessionConfig.cookie.secure = true;
    sessionConfig.cookie.sameSite = "none";
    sessionConfig.cookie.httpOnly = false;
    sessionConfig.cookie.domain = config.app.domain;
  }

  app.use(session(sessionConfig));
};

export default setupSession;

export { sessionConfig, defaultCookie };
