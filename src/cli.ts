#!/usr/bin/env node

import { join } from "node:path";
import { readdirSync, readFileSync, rmSync } from "node:fs";

import pc from "picocolors";
import { program } from "commander";

import { uploadSourcemaps, UploadError } from "./upload.js";
import { homedir } from "node:os";
import { exec } from "node:child_process";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"));

console.log();
console.log(pc.magenta(pc.bold("  monocle.sh")), pc.dim(`v${pkg.version}`));
console.log();

program
  .name("monocle")
  .description("Monocle CLI - upload source maps and manage your Monocle projects")
  .version(pkg.version);

program
  .command("sourcemaps")
  .description("Manage source maps")
  .command("upload")
  .description("Upload source maps to Monocle")
  .argument("<patterns...>", "Glob patterns for source map files (e.g., ./dist/**/*.map)")
  .option("--api-key <key>", "Monocle API key (or set MONOCLE_API_KEY env var)")
  .option("--release <version>", "Release version (e.g., v1.2.3 or git SHA)")
  .option("--url <url>", "Monocle API URL", "https://api.monocle.sh")
  .option("--dry-run", "Show what would be uploaded without uploading")
  .action(async (patterns: string[], options) => {
    const apiKey = options.apiKey || process.env.MONOCLE_API_KEY;

    if (!apiKey) {
      console.error(pc.red("Error: Missing API key"));
      console.error("Provide --api-key option or set MONOCLE_API_KEY environment variable");
      process.exit(1);
    }

    if (!options.release) {
      console.error(pc.red("Error: Missing --release option"));
      console.error(
        "Provide a release version (e.g., --release=v1.2.3 or --release=$(git rev-parse HEAD))",
      );
      process.exit(1);
    }

    try {
      await uploadSourcemaps({
        patterns,
        apiKey,
        release: options.release,
        apiUrl: options.url,
        dryRun: options.dryRun,
      });
    } catch (error) {
      // UploadError messages are already sanitized (no API keys, etc.)
      // For unexpected errors, show a generic message
      if (error instanceof UploadError) {
        console.error(pc.red(`Error: ${error.message}`));
      } else {
        console.error(pc.red("Error: An unexpected error occurred"));
      }
      process.exit(1);
    }
  });

/**
 * `monocle studio` command group — local DevTools server and data access.
 */
const studio = program
  .command("studio")
  .description("Local DevTools server for development observability");

studio
  .command("dev")
  .description("Start the local Studio server")
  .option("--port <port>", "Port for the Studio server", "4200")
  .option("--host <host>", "Host to bind to", "0.0.0.0")
  .option("--open", "Open browser automatically")
  .option("--clean", "Reset all stored data before starting")
  .option("--db-path <path>", "Custom path for DuckDB database")
  .action(async (options) => {
    const port = Number.parseInt(options.port, 10);

    if (options.clean) {
      const configDir = join(homedir(), ".config", "monocle");
      try {
        for (const file of readdirSync(configDir)) {
          if (file.endsWith(".db") || file.endsWith(".db-wal") || file.endsWith(".db-shm")) {
            rmSync(join(configDir, file));
          }
        }
        console.log(pc.green("Data cleared."));
      } catch {}
    }

    let devtools: any;
    try {
      devtools = await import("@monocle.sh/studio" as string);
    } catch {
      console.error(pc.red("Error: @monocle.sh/studio is not installed"));
      console.error("Install it with: pnpm add -D @monocle.sh/studio");
      process.exit(1);
    }

    try {
      await devtools.startServer({ port, host: options.host, dbPath: options.dbPath });
      if (options.open) exec(`open http://localhost:${port}`);
    } catch (error) {
      console.error(pc.red("Failed to start DevTools server"));
      if (error instanceof Error) console.error(error.message);
      process.exit(1);
    }
  });

studio
  .command("traces")
  .description("List recent traces from Studio")
  .option("-p, --port <port>", "Studio server port", "4200")
  .option("-f, --format <format>", "Output format: pretty, json, short", "pretty")
  .option("-n, --limit <limit>", "Number of traces to fetch", "25")
  .option("-s, --service <service>", "Filter by service name")
  .option("--trace-id <traceId>", "Filter by trace ID")
  .action(async (options) => {
    const { fetchTraces } = await import("./studio/fetch.js");
    await fetchTraces(options);
  });

studio
  .command("logs")
  .description("List recent logs from Studio")
  .option("-p, --port <port>", "Studio server port", "4200")
  .option("-f, --format <format>", "Output format: pretty, json, short", "pretty")
  .option("-n, --limit <limit>", "Number of logs to fetch", "50")
  .option("--severity <severity>", "Filter by severity (error, warn, info, debug)")
  .option("--search <search>", "Search in log body and attributes")
  .option("--trace-id <traceId>", "Filter by trace ID")
  .action(async (options) => {
    const { fetchLogs } = await import("./studio/fetch.js");
    await fetchLogs(options);
  });

studio
  .command("errors")
  .description("List recent errors and exceptions from Studio")
  .option("-p, --port <port>", "Studio server port", "4200")
  .option("-f, --format <format>", "Output format: pretty, json, short", "pretty")
  .option("-n, --limit <limit>", "Number of errors to fetch", "25")
  .option("--trace-id <traceId>", "Filter by trace ID")
  .action(async (options) => {
    const { fetchErrors } = await import("./studio/fetch.js");
    await fetchErrors(options);
  });

studio
  .command("install-agents")
  .description("Add Monocle Studio instructions to AGENTS.md or CLAUDE.md")
  .action(async (options) => {
    const { installAgents } = await import("./studio/install_agents.js");
    await installAgents(options);
  });

program.parse();
