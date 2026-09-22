/**
 * Logging helper.
 *
 * CRITICAL: this server speaks MCP over stdio. Anything written to stdout
 * corrupts the JSON-RPC stream and breaks the client connection, so every
 * diagnostic message goes to stderr via console.error.
 */

export type LogLevel = "silent" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { silent: 0, info: 1, debug: 2 };

function resolveLevel(): LogLevel {
  const raw = (process.env.VIBECHECK_LOG_LEVEL ?? "info").toLowerCase();
  return raw === "silent" || raw === "debug" ? raw : "info";
}

let level: LogLevel = resolveLevel();

export function setLogLevel(next: LogLevel): void {
  level = next;
}

/**
 * Re-read `VIBECHECK_LOG_LEVEL` from the environment.
 *
 * The level is resolved when this module is first evaluated, which is *before*
 * a `.env` file can be applied, so the entry point calls this after loading one.
 */
export function refreshLogLevel(): LogLevel {
  level = resolveLevel();
  return level;
}

function emit(min: LogLevel, message: string, detail?: unknown): void {
  if (LEVELS[level] < LEVELS[min]) return;
  const suffix = detail === undefined ? "" : ` ${safeJson(detail)}`;
  console.error(`[vibecheck] ${message}${suffix}`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (message: string, detail?: unknown) => emit("info", message, detail),
  debug: (message: string, detail?: unknown) => emit("debug", message, detail),
  warn: (message: string, detail?: unknown) => emit("info", `WARN ${message}`, detail),
  error: (message: string, detail?: unknown) => emit("info", `ERROR ${message}`, detail),
};
