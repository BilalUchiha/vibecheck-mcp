/**
 * `.env` support.
 *
 * The server is normally launched *by* the MCP client (Claude Code, Cursor, …),
 * so the person configuring it rarely controls the process environment. That
 * makes the two supported routes: an `env` block in the client's config, or a
 * `.env` file next to the project.
 *
 * This module deliberately has **no import side effect**. Loading a `.env` at
 * import time would make the test suite depend on whatever file happened to sit
 * in the repository root, so callers (the server entry point, the inspect
 * script, tests) opt in explicitly and pass an explicit cwd when they need
 * isolation.
 *
 * Values are never logged. Only the file names and the *names* of the keys that
 * were applied are ever reported, so a key cannot leak into a log line.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of this package, so a `.env` shipped next to the checkout works. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DotEnvOptions {
  /** Directory to look in. Defaults to the process working directory. */
  cwd?: string;
  /** Explicit file, overriding `VIBECHECK_ENV_FILE`. Relative paths resolve against `cwd`. */
  envFile?: string;
  /** Skip the package-root fallback. Used by tests that want a single, controlled file. */
  skipPackageRoot?: boolean;
}

export interface DotEnvResult {
  /** Files that existed and were read, in the order they were applied. */
  loaded: string[];
  /** Names of the variables actually set. Never values. */
  keys: string[];
}

/**
 * Where a `.env` may live, most specific first: an explicit file, the working
 * directory the client launched us in, then this package's own root.
 */
export function candidateEnvFiles(options: DotEnvOptions = {}): string[] {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicit = options.envFile ?? process.env.VIBECHECK_ENV_FILE;

  const candidates: string[] = [];
  if (explicit) candidates.push(path.resolve(cwd, explicit));
  candidates.push(path.join(cwd, ".env"));
  if (!options.skipPackageRoot) candidates.push(path.join(PACKAGE_ROOT, ".env"));

  return [...new Set(candidates)];
}

/**
 * Parse dotenv syntax: `KEY=value`, `export KEY=value`, `#` comments, blank
 * lines, and single- or double-quoted values. Invalid lines are skipped rather
 * than throwing, because a malformed `.env` should degrade to "no key set",
 * which surfaces as the offline-mock warning instead of a crash on startup.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;

    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value may carry a trailing comment: `PORT=3000  # dev`.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    parsed[key] = value;
  }

  return parsed;
}

/**
 * Read the candidate files and apply the first value seen for each key.
 *
 * Real environment variables always win, which is what lets a client's `env`
 * block override a `.env` in the repository. The one nuance: an *empty* real
 * value does not shadow a populated `.env` entry, so `export TYPESAFE_API_KEY=`
 * in a shell profile cannot mask the key the user put in the file.
 */
export function loadDotEnvFiles(options: DotEnvOptions = {}): DotEnvResult {
  const loaded: string[] = [];
  const keys: string[] = [];

  for (const file of candidateEnvFiles(options)) {
    let contents: string;
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch {
      continue; // absent or unreadable: try the next candidate
    }

    const parsed = parseDotEnv(contents);
    for (const [key, value] of Object.entries(parsed)) {
      const existing = process.env[key];
      if (existing !== undefined && existing.trim().length > 0) continue;
      process.env[key] = value;
      if (!keys.includes(key)) keys.push(key);
    }

    loaded.push(file);
  }

  return { loaded, keys };
}
