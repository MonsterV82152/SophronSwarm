/**
 * Structured logger — thin wrapper over pino.
 *
 * Level is controlled by SOPHRON_LOG_LEVEL (default: info).
 * In dev (tsx) output is pretty-printed; in production it's newline JSON.
 */
import pino from "pino";

const level = process.env["SOPHRON_LOG_LEVEL"] ?? "info";
const isDev = !process.env["NODE_ENV"] || process.env["NODE_ENV"] === "development";

export const log = pino(
  isDev
    ? {
        level,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : { level },
);
