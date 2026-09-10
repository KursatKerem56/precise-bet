import { NextFunction, Request, Response } from "express";

import { Errors } from "@Common/Constants";

import logger from "@Utils/Logger";
import { ExpressFunction } from "@Common/Types";

class AppError extends Error {
  public code: string;
  public statusCode = 500;
  public service: string | undefined;
  public locale_key: string | undefined;
  public type: string | undefined;
  constructor(
    code: keyof typeof Errors,
    additionalMessage?: unknown,
    extraClientMessage?: unknown
  ) {
    let error = Errors[code];

    if (!error) {
      // logger.error(`[AppError] [NONE] ${code} is not a valid error code`);

      error = Errors.UNEXPECTED_ERROR;
    }

    const { message, service, type, statusCode, locale_key } = error;

    super(message + (extraClientMessage ?? ""));
    // logger?.error(
    //   `[AppError] [${service}] ${message}. Message: ${additionalMessage}`
    // );
    this.code = code;
    this.service = service;
    this.locale_key = locale_key;
    this.type = type;
    this.name = "AppError";
    this.stack = new Error().stack;
    this.statusCode = statusCode;
  }
}

const asyncErrorHandler =
  (fn: ExpressFunction) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

const setupErrorHandling = async () => {
  process.on("unhandledRejection", (err) => {
    logger.fatal("Unhandled rejection: ", err);
    console.log(err);
  });

  process.on("uncaughtException", (err) => {
    logger.fatal("Uncaught exception: ", err);
    console.log(err);
  });

  process.on("exit", () => {
    logger.info("Server shutting down at " + new Date().toISOString());
  });
};

export { asyncErrorHandler, setupErrorHandling, AppError };
