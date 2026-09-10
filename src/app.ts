import { createServer } from "http";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import requestIp from "request-ip";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import chalk from "chalk";
import cors from "cors";

import setupRoutes from "@Routes/index";

import setupSession from "@Config/Express/Session";
import connectDB from "@Config/Db";
import config from "@Config/Environment";

import { serializeUserWithJWT } from "@Middlewares/Auth";
import { errorMiddleware } from "@Middlewares/Error";
import setRealUserIP from "@Middlewares/IP";

import logger from "@Utils/Logger";
import { setupErrorHandling } from "@Utils/Error";

const limiter = rateLimit({
  windowMs: 1 * 30 * 1000,
  max: 600,
  keyGenerator: async (req) => {
    return req.headers["x-forwarded-for"] || req.connection.remoteAddress;
  },
  message: async (req: Request, res: Response) => {
    res.status(429).json({
      statusCode: 429,
      locale_key: "api.error.too_many_requests",
      message: "Too many requests, please try again later",
    });
  },
});

const app = express();

app.set("trust proxy", true);

if (app.get("env") === "production") {
  app.enable("trust proxy");
  app.use(helmet());
}

// app.use(excludeAccessToken);

app.use(limiter);
// app.use(blockIps);
app.use(express.json({ limit: "50mb" }));

const httpServer = createServer(app);

app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// app.use(requestLogger);

app.use(
  cors({
    origin: config.frontend.url,
    credentials: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["authorization", "cookie"],
  })
);
app.use(requestIp.mw());
app.use(setRealUserIP);
app.use(serializeUserWithJWT);

setupSession(app);
setupRoutes(app);

app.use(errorMiddleware);

const PORT = config.app.port || 3005;

httpServer.listen(PORT, async () => {
  await connectDB();

  await setupErrorHandling();

  logger.info(`Server listening on port ${chalk.green(PORT)}`);
});
