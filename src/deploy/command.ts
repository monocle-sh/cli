import type { Command } from "commander";
import { DeploymentClient, DeploymentRequestError } from "./client.js";
import {
  DeploymentDetectionError,
  DeploymentMetadata,
  DeploymentValidationError,
} from "./metadata.js";
import type { DeployOptions } from "./types.js";

export class DeployCommand {
  static #redact(input: { text: string; options: DeployOptions }): string {
    let text = input.text;
    for (const secret of [input.options.apiKey, process.env.MONOCLE_API_KEY]) {
      if (!secret) continue;
      text = text.split(secret).join("[REDACTED]");
      text = text.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    }

    return text;
  }

  static async #run(options: DeployOptions): Promise<void> {
    try {
      if (options.apiKey !== undefined && !options.apiKey.trim())
        throw new DeploymentValidationError("Empty --api-key.");
      const report = DeploymentMetadata.resolve({ options });
      const url = DeploymentMetadata.validateUrl({
        value: options.url ?? "https://api.monocle.sh",
      });
      const apiKey = options.apiKey ?? process.env.MONOCLE_API_KEY;
      if (options.dryRun) {
        console.log(this.#redact({ text: JSON.stringify(report, null, 2), options }));

        return;
      }
      if (!apiKey?.trim())
        throw new DeploymentDetectionError("Missing --api-key or MONOCLE_API_KEY.");

      const status = await DeploymentClient.send({ url, apiKey, payload: report.payload });
      const messages: Record<number, string> = {
        200: "Deployment updated.",
        201: "Deployment created.",
        202: "Deployment accepted without storage: deployments are not enabled for this organization.",
      };
      console.log(messages[status]);
    } catch (error) {
      const local = error instanceof DeploymentValidationError;
      const message =
        local ||
        error instanceof DeploymentDetectionError ||
        error instanceof DeploymentRequestError
          ? error.message
          : "An unexpected deployment error occurred.";
      const failed = local || options.strict;
      console.error(this.#redact({ text: `${failed ? "Error" : "Warning"}: ${message}`, options }));
      process.exitCode = failed ? 1 : 0;
    }
  }

  static register(program: Command): void {
    program
      .command("deploy")
      .description("Declare a deployment in Monocle")
      .option("--service <name>", "Service name (required)")
      .option("--environment <slug>", "Environment slug (or MONOCLE_ENVIRONMENT)")
      .option(
        "--version <version>",
        "Explicit version (or MONOCLE_VERSION); detected SHA uses commitSha",
      )
      .option("--commit <sha>", "Commit SHA (defaults to CI or Git)")
      .option("--status <status>", "started, succeeded (default), failed, or canceled")
      .option("--started-at <timestamp>", "Start time in ISO 8601 format")
      .option("--finished-at <timestamp>", "Finish time in ISO 8601 format")
      .option(
        "--external-id <id>",
        "Deployment identity (defaults to CI run identity or a generated UUID)",
      )
      .option("--actor <actor>", "Deployment actor (defaults to CI actor)")
      .option("--ci-url <url>", "CI run URL")
      .option("--api-key <key>", "Private application API key (or MONOCLE_API_KEY)")
      .option("--url <url>", "Monocle API URL", "https://api.monocle.sh")
      .option("--strict", "Exit with code 1 on detection or request errors")
      .option("--dry-run", "Print payload and field provenance without sending")
      .action((options: DeployOptions) => this.#run(options));
  }
}
