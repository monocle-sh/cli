#!/usr/bin/env node

import { join } from "node:path";
import { readdirSync, readFileSync, rmSync } from "node:fs";

import pc from "picocolors";
import { program } from "commander";

import { DebugFilesCommand } from "./debug_files/command.js";
import { DeployCommand } from "./deploy/command.js";
import { SourcemapsCommand } from "./sourcemaps/command.js";
import { homedir } from "node:os";
import { exec } from "node:child_process";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"));

console.log();
console.log(pc.magenta(pc.bold("  monocle.sh")), pc.dim(`v${pkg.version}`));
console.log();

program
  .name("monocle")
  .enablePositionalOptions()
  .description("Monocle CLI - upload source maps and manage your Monocle projects")
  .version(pkg.version);

SourcemapsCommand.register(program);
DebugFilesCommand.register(program);

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
      const { createCliUpdateBridge } = await import("./studio/update_bridge.js");
      const updateBridge = createCliUpdateBridge({ currentVersion: pkg.version });

      await devtools.startServer({
        port,
        host: options.host,
        dbPath: options.dbPath,
        updateBridge,
      });
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

DeployCommand.register(program);

await program.parseAsync();
