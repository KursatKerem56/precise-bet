import chalk from "chalk";

import config from "@Config/Environment";

import { ILogger } from "@Common/Types";
import { ELogLevel } from "@Common/Constants";

let lastLevel: ELogLevel;

const logLevel = config.log.level;

const trace = (...messages: unknown[]) => {
  log(ELogLevel.TRACE, ...messages);
};

const debug = (...messages: unknown[]) => {
  log(ELogLevel.DEBUG, ...messages);
};

const info = (...messages: unknown[]) => {
  log(ELogLevel.INFO, ...messages);
};

const warn = (...messages: unknown[]) => {
  log(ELogLevel.WARN, ...messages);
};

const error = (...messages: unknown[]) => {
  log(ELogLevel.ERROR, ...messages);
};

const fatal = (...messages: unknown[]) => {
  // Log asynchonously, so that the process can exit after sending cloudwatch and others.
  (async () => {
    log(ELogLevel.FATAL, ...messages);
  })();
};

const log = async (type: ELogLevel, ...messages: unknown[]) => {
  let color = chalk.white;
  switch (type) {
    case ELogLevel.TRACE:
      color = chalk.gray;
      break;
    case ELogLevel.DEBUG:
      color = chalk.blue;
      break;
    case ELogLevel.INFO:
      color = chalk.green;
      break;
    case ELogLevel.WARN:
      color = chalk.yellow;
      break;
    case ELogLevel.ERROR:
      color = chalk.red;
      break;
    case ELogLevel.FATAL:
      color = chalk.bgRed;
      break;
    case ELogLevel.ADMIN:
      color = chalk.bgBlue;
      break;
  }

  const message = `${color(
    `[${new Date().toISOString()} ${ELogLevel[type]}]`
  )} ${messages.join(" ").trim()}`;

  lastLevel = type;

  type = type === ELogLevel.ADMIN ? ELogLevel.INFO : type;

  if (logLevel <= type) {
    console.log(message);
  }
};

export const logger: ILogger = {
  trace,
  debug,
  info,
  warn,
  error,
  fatal,
};

export default logger;
