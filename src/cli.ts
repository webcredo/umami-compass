#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toSafeError, UmamiError } from "./api/errors.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `Umami Compass ${VERSION}

A secure MCP server for Umami Analytics Cloud and self-hosted deployments.

Usage:
  umami-compass
  umami-compass --help
  umami-compass --version

The server uses stdio. Configure it through environment variables; see .env.example
and https://github.com/webcredo/umami-compass#configuration.
`;

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (argument === "--help" || argument === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (argument === "--version" || argument === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (process.argv.length > 2) {
    throw new UmamiError(
      "CONFIGURATION_ERROR",
      "Umami Compass does not accept positional arguments. Use --help for usage.",
    );
  }

  const server = createServer({ config: loadConfig() });
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const safeError = toSafeError(error);
  console.error(`[umami-compass] ${safeError.message}`);
  process.exitCode = 1;
});
