#!/usr/bin/env node
/**
 * Entry point.
 *
 * Speaks MCP over stdio, which is what Claude Code, Cursor and most other MCP
 * clients expect for a local server. Because stdout carries the JSON-RPC stream,
 * every diagnostic message goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hasApiKey } from "./config.js";
import { loadDotEnvFiles } from "./env.js";
import { log, refreshLogLevel } from "./logger.js";
import { createServer } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

// The MCP client launches this process, so the user usually configures it from
// a `.env` rather than from their shell. Do this before anything reads the
// environment; `refreshLogLevel` then honours a level set in that file.
const dotenv = loadDotEnvFiles();
refreshLogLevel();

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  log.info(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
  if (dotenv.loaded.length > 0) {
    log.info("loaded environment from .env", {
      files: dotenv.loaded,
      keys: dotenv.keys, // names only, never values
    });
  }
  if (hasApiKey()) {
    log.info("TYPESAFE_API_KEY is set; verdicts will come from Jev");
  } else {
    log.warn(
      "TYPESAFE_API_KEY is not set, so reviews will use the offline heuristic mock instead of Jev. Set the key in this server's environment (or a .env file) for real verdicts.",
    );
  }
}

main().catch((error: unknown) => {
  log.error("fatal error during startup", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
