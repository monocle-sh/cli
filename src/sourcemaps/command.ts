import { relative, resolve } from "node:path";

import pc from "picocolors";
import { Spinner } from "picospinner";
import type { Command } from "commander";
import {
  injectDebugIds,
  SourcemapsError,
  SourcemapsUploadError,
  uploadSourcemaps,
} from "@monocle.sh/sourcemaps";

type UploadOptions = { apiKey?: string; url: string; release?: string };

/**
 * `monocle sourcemaps inject` and `monocle sourcemaps upload`, for any bundler.
 */
export class SourcemapsCommand {
  static #fail(message: string, hints: string[] = []): void {
    console.error(pc.red(`Error: ${message}`));
    for (const hint of hints) console.error(hint);
    process.exitCode = 1;
  }

  /**
   * Library errors are safe to print; anything else may leak details.
   */
  static #handleError(error: unknown): void {
    if (error instanceof SourcemapsError) return this.#fail(error.message);

    this.#fail("An unexpected error occurred");
  }

  static #sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return url;
    }
  }

  static async #inject(directory: string): Promise<void> {
    const root = resolve(directory);
    const spinner = new Spinner(`Injecting debug IDs in ${directory}...`);
    spinner.start();

    try {
      const { files } = await injectDebugIds({ directory: root });
      const injected = files.filter((file) => file.status === "injected");
      const already = files.filter((file) => file.status === "already_injected");
      const invalid = files.filter((file) => file.status === "invalid_sourcemap");

      if (injected.length + already.length === 0 && invalid.length === 0) {
        spinner.fail("No JavaScript files with source maps found");
        return this.#fail(`Nothing to inject in ${root}`, [
          pc.dim("Enable source maps in your bundler (for example `build.sourcemap: 'hidden'`)."),
        ]);
      }

      spinner.succeed(
        `Injected debug IDs into ${injected.length} file(s)` +
          (already.length ? pc.dim(` (${already.length} already injected)`) : ""),
      );
      for (const file of injected)
        console.log(pc.dim(`  ${relative(root, file.file)} ${pc.cyan(file.debugId!)}`));

      if (invalid.length === 0) return;
      for (const file of invalid) console.error(pc.yellow(`  ${file.error}`));
      this.#fail(`${invalid.length} file(s) have an invalid source map`);
    } catch (error) {
      spinner.fail("Debug ID injection failed");
      this.#handleError(error);
    }
  }

  static async #upload(directory: string, options: UploadOptions): Promise<void> {
    const apiKey = options.apiKey || process.env.MONOCLE_API_KEY;
    if (!apiKey)
      return this.#fail("Missing API key", [
        "Provide --api-key option or set MONOCLE_API_KEY environment variable",
      ]);

    const host = this.#sanitizeUrl(options.url);
    const spinner = new Spinner(`Uploading source maps to ${host}...`);
    // Printed once the spinner stops, such as a plain HTTP API URL.
    const warnings: string[] = [];
    const printWarnings = () => {
      for (const warning of warnings) console.warn(pc.yellow(`Warning: ${warning}`));
    };
    spinner.start();

    try {
      const result = await uploadSourcemaps({
        directory,
        apiKey,
        apiUrl: options.url,
        release: options.release,
        logger: {
          info: (message) => spinner.setText(message),
          warn: (message) => warnings.push(message),
        },
      });
      const count = result.uploaded.length + result.skipped.length;
      if (count === 0) {
        spinner.fail("No JavaScript files with source maps found");
        return this.#fail(`Nothing to upload in ${resolve(directory)}`, [
          pc.dim("Build with source maps enabled, then run `monocle sourcemaps inject` first."),
        ]);
      }

      spinner.succeed(
        `Uploaded ${result.uploaded.length} source map(s)` +
          (options.release ? ` for release ${pc.cyan(options.release)}` : "") +
          (result.skipped.length ? pc.dim(` (${result.skipped.length} already uploaded)`) : ""),
      );
      printWarnings();
      for (const file of result.uploaded)
        console.log(pc.dim(`  ${file.filePath} ${pc.cyan(file.debugId)}`));
    } catch (error) {
      spinner.fail(
        error instanceof SourcemapsUploadError
          ? "Some source maps failed to upload"
          : "Source map upload failed",
      );
      printWarnings();
      this.#handleError(error);
    }
  }

  static register(program: Command): void {
    const sourcemaps = program.command("sourcemaps").description("Manage source maps");

    sourcemaps
      .command("inject")
      .description("Inject debug IDs into built JavaScript files and their source maps")
      .argument("<directory>", "Build output directory (e.g., ./dist)")
      .action((directory: string) => this.#inject(directory));

    sourcemaps
      .command("upload")
      .description("Upload source maps with debug IDs to Monocle")
      .argument("<directory>", "Build output directory, after `monocle sourcemaps inject`")
      .option("--api-key <key>", "Monocle API key (or set MONOCLE_API_KEY env var)")
      .option("--release <version>", "Release shown next to the files (e.g., v1.2.3 or git SHA)")
      .option("--url <url>", "Monocle API URL", "https://api.monocle.sh")
      .action((directory: string, options: UploadOptions) => this.#upload(directory, options));
  }
}
