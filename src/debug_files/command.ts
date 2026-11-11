import type { NonSharedBuffer } from "node:buffer";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";

import pc from "picocolors";
import type { Command } from "commander";

import { NativeModule, NativeModuleError, type Inspection } from "./native.js";
import { SourceCollector, SourcesError, type SourceCounts } from "./sources.js";
import { NativeUploader, NativeUploadError } from "./upload.js";

type SourceOptions = { includeSources?: boolean; root: string; prefix?: string };
type UploadOptions = SourceOptions & {
  apiKey?: string;
  url: string;
  release?: string;
  force?: boolean;
};

const MAX_DEBUG_BYTES = 200 * 1024 * 1024;

class DebugFileError extends Error {}

/**
 * `monocle debug-files check` and `monocle debug-files upload`, for Linux ELF/DWARF builds.
 */
export class DebugFilesCommand {
  static #fail(message: string): void {
    console.error(pc.red(`Error: ${message}`));
    process.exitCode = 1;
  }

  static #handleError(error: unknown): void {
    if (
      error instanceof DebugFileError ||
      error instanceof NativeModuleError ||
      error instanceof SourcesError ||
      error instanceof NativeUploadError
    )
      return this.#fail(error.message);

    this.#fail("An unexpected error occurred");
  }

  static #size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;

    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  /**
   * Names the debug file in errors of the WebAssembly module, such as an invalid ELF file.
   */
  static async #native<T>(file: string, operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (error instanceof NativeModuleError) throw new DebugFileError(`${file}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reads a debug file and checks that Monocle can use it.
   */
  static async #inspect(file: string, sources: { root: string; prefix: string } | undefined) {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new DebugFileError(`${file} is not a file`);
    if (info.size > MAX_DEBUG_BYTES)
      throw new DebugFileError(
        `${file} exceeds the 200 MiB limit. Upload a compressed debug file instead: ` +
          "objcopy --only-keep-debug --compress-debug-sections=zlib <binary> <binary>.debug",
      );

    const bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => {
      throw new DebugFileError(`Could not read ${file} (${error.code ?? error.message})`);
    });
    const inspection = await this.#native(
      file,
      NativeModule.inspect({ bytes, prefix: sources?.prefix }),
    );
    const codeId = inspection.codeId;
    if (!codeId)
      throw new DebugFileError(
        `${file} has no GNU build ID. Link with -C link-arg=-Wl,--build-id and rebuild.`,
      );
    // The API only accepts 4 to 64 byte build IDs: fail before reading sources or sending anything.
    if (!/^(?:[\da-f]{2}){4,64}$/.test(codeId))
      throw new DebugFileError(
        `${file} has a ${codeId.length / 2} byte build ID; Monocle accepts 4 to 64 bytes. ` +
          "Link with -C link-arg=-Wl,--build-id and rebuild.",
      );
    if (!inspection.hasDebugInfo)
      throw new DebugFileError(
        `${file} has no DWARF debug information. Set debug = 1 in [profile.release] ` +
          "and upload the binary before stripping it.",
      );

    return { bytes, inspection: { ...inspection, codeId } };
  }

  static async #sourceOptions(options: SourceOptions) {
    if (!options.includeSources) return;

    const root = await realpath(options.root).catch(() => undefined);
    if (!root || !(await stat(root)).isDirectory())
      throw new DebugFileError(`--root ${options.root} is not a directory`);
    if (options.prefix === "") throw new DebugFileError("--prefix must not be empty");

    return { root, prefix: options.prefix ?? root };
  }

  static async #collect(options: {
    file: string;
    inspection: Inspection;
    sources: { root: string; prefix: string };
  }) {
    const { files, counts } = await SourceCollector.collect({
      inspection: options.inspection,
      root: options.sources.root,
    });
    this.#printCounts(options.inspection, counts);
    if (files.length === 0)
      throw new DebugFileError(
        `No source files of ${options.file} found beneath ${options.sources.root}. ` +
          `The debug file references paths that do not start with ${options.sources.prefix}: ` +
          "run the command from the build checkout, or pass the build directory with --prefix.",
      );

    return files;
  }

  static #printCounts(inspection: Inspection, counts: SourceCounts): void {
    const skipped = [
      [inspection.outsidePrefix, "outside the prefix"],
      [counts.missing, "missing"],
      [counts.outsideRoot, "outside the root"],
      [counts.nonUtf8 + inspection.nonUtf8, "not UTF-8"],
    ]
      .filter(([count]) => count)
      .map(([count, reason]) => `${count} ${reason}`);
    console.log(
      `  Sources: ${counts.included} file(s), ${this.#size(counts.bytes)}` +
        pc.dim(skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""),
    );
  }

  static async #check(files: string[], options: SourceOptions): Promise<void> {
    try {
      const sources = await this.#sourceOptions(options);
      for (const file of files) {
        const { bytes, inspection } = await this.#inspect(file, sources);
        console.log(
          `${pc.green("✔")} ${file} ${pc.cyan(`elf:${inspection.codeId}`)} ${pc.dim(this.#size(bytes.length))}`,
        );
        if (!sources) continue;

        const collected = await this.#collect({ file, inspection, sources });
        for (const source of collected) console.log(pc.dim(`    ${source.path}`));
      }
    } catch (error) {
      this.#handleError(error);
    }
  }

  static async #upload(files: string[], options: UploadOptions): Promise<void> {
    try {
      const apiKey = options.apiKey || process.env.MONOCLE_API_KEY;
      if (!apiKey)
        throw new DebugFileError("Missing --api-key or MONOCLE_API_KEY (a Deploy project token)");
      let apiUrl: URL;
      try {
        apiUrl = new URL(options.url);
      } catch {
        throw new DebugFileError("Invalid --url");
      }
      const sources = await this.#sourceOptions(options);
      const uploader = new NativeUploader({
        apiUrl: apiUrl.origin + apiUrl.pathname.replace(/\/+$/, ""),
        apiKey,
        release: options.release,
        force: options.force,
      });

      // Read every file and build every bundle before the first request, so an invalid file
      // anywhere in the list uploads nothing.
      const builds = new Map<
        string,
        { file: string; bytes: NonSharedBuffer; bundle?: NonSharedBuffer }
      >();
      for (const file of files) {
        const { bytes, inspection } = await this.#inspect(file, sources);
        const id = pc.cyan(`elf:${inspection.codeId}`);
        // A binary and its extracted .debug share a build ID: upload it once.
        if (builds.has(inspection.codeId)) {
          console.log(pc.dim(`${file} ${id}: same build as a previous file, skipped`));
          continue;
        }
        console.log(`${file} ${id} ${pc.dim(this.#size(bytes.length))}`);

        const collected = sources ? await this.#collect({ file, inspection, sources }) : undefined;
        const bundle = collected
          ? await this.#native(
              file,
              NativeModule.bundle({ codeId: inspection.codeId, files: collected }),
            )
          : undefined;
        builds.set(inspection.codeId, { file, bytes, bundle });
      }

      for (const [codeId, { file, bytes, bundle }] of builds) {
        const id = pc.cyan(`elf:${codeId}`);
        const debug = await uploader.upload({
          codeId,
          kind: "debug",
          fileName: basename(file),
          bytes,
        });
        console.log(
          `${pc.green("✔")} ${file} ${id}: debug file ${debug === "exists" ? "already uploaded" : "uploaded"}`,
        );
        if (!bundle) continue;

        const result = await uploader.upload({
          codeId,
          kind: "sources",
          fileName: `${basename(file)}.sources.zip`,
          bytes: bundle,
        });
        console.log(
          `${pc.green("✔")} ${file} ${id}: sources ${result === "exists" ? "already uploaded" : `uploaded (${this.#size(bundle.length)})`}`,
        );
      }
    } catch (error) {
      this.#handleError(error);
    }
  }

  static register(program: Command): void {
    const command = program
      .command("debug-files")
      .description("Upload Linux debug files to resolve native stack traces");

    const sourceOptions = (subcommand: Command) =>
      subcommand
        .option("--include-sources", "Also upload the source files referenced by each debug file")
        .option("--root <dir>", "Checkout the sources are read from", ".")
        .option(
          "--prefix <path>",
          "Build directory recorded in the debug file, when it differs from --root (e.g. /app in Docker)",
        )
        .hook("preAction", (current) => {
          if (current.opts().includeSources) return;

          const ignored = ["root", "prefix"].filter(
            (name) => current.getOptionValueSource(name) === "cli",
          );
          if (ignored.length)
            console.warn(
              pc.yellow(
                `Warning: ${ignored.map((name) => `--${name}`).join(" and ")} ignored without --include-sources`,
              ),
            );
        });

    sourceOptions(
      command
        .command("check")
        .description("Print the build ID of each file, and with --include-sources its source files")
        .argument("<files...>", "Unstripped binaries or extracted .debug files"),
    ).action((files: string[], options: SourceOptions) => this.#check(files, options));

    sourceOptions(
      command
        .command("upload")
        .description("Upload debug files, and optionally their sources, to Monocle")
        .argument("<files...>", "Unstripped binaries or extracted .debug files"),
    )
      .option("--release <version>", "Release shown next to the files (e.g., v1.2.3 or git SHA)")
      .option("--force", "Replace files already uploaded for the same build ID")
      .option("--api-key <key>", "Project token with the Deploy scope (or set MONOCLE_API_KEY)")
      .option("--url <url>", "Monocle API URL", "https://api.monocle.sh")
      .action((files: string[], options: UploadOptions) => this.#upload(files, options));
  }
}
