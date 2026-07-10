#!/usr/bin/env node
import pino from "pino";
import { loadHubConfig } from "./config.js";
import { createHubServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadHubConfig();
  const logger = pino({
    level: config.logLevel,
    redact: {
      paths: ["agentToken", "webToken", "req.headers.authorization", "nonce"],
      censor: "[redacted]",
    },
  });
  if (config.authMode === "dev") {
    logger.warn("Hub is in local development auth mode; do not expose it to the tailnet");
  }
  const server = await createHubServer(config, logger);
  await server.start();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Muxline hub: ${message}\n`);
  process.exitCode = 1;
});
