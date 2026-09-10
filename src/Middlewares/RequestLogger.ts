import { Request, Response, NextFunction } from "express";
import fs from "fs";
import util from "util";

const logFilePath = "request.log";

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const logData =
    `======================= REQUEST RECEIVED =======================\n` +
    `Timestamp: ${new Date().toISOString()}\n` +
    `Method: ${req.method}\n` +
    `URL: ${req.originalUrl}\n` +
    `IP Address: ${req.ip}\n` +
    `Headers: ${util.inspect(req.headers, { depth: null })}\n` +
    `Query Parameters: ${util.inspect(req.query, { depth: null })}\n` +
    `Body: ${util.inspect(req.body, { depth: null })}\n` +
    `Cookies: ${util.inspect(req.cookies, { depth: null })}\n`;

  fs.appendFile(logFilePath, logData, (err) => {
    if (err) {
      console.error("Error writing to log file:", err);
    }
  });

  next();
};
