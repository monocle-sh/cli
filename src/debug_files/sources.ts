import { open, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

import type { Inspection } from "./native.js";

/**
 * Same limits as the symbolicator, which rejects larger bundles.
 */
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_LINES = 1_000_000;

export class SourcesError extends Error {}

export type SourceCounts = {
  included: number;
  bytes: number;
  outsideRoot: number;
  missing: number;
  nonUtf8: number;
};

/**
 * Reads the DWARF source files from the build checkout. Only regular files beneath the root are
 * read, after resolving symlinks, so a debug file cannot point the CLI at other local files.
 */
export class SourceCollector {
  static #decoder = new TextDecoder("utf-8", { fatal: true });

  static async #read(path: string): Promise<Buffer | undefined> {
    const file = await open(path, "r").catch(() => undefined);
    if (!file) return;

    try {
      if (!(await file.stat()).isFile()) return;
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }

      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  }

  static async collect(options: { inspection: Inspection; root: string }) {
    const counts: SourceCounts = { included: 0, bytes: 0, outsideRoot: 0, missing: 0, nonUtf8: 0 };
    const files: Array<{ path: string; text: string }> = [];
    let lines = 0;

    for (const candidate of options.inspection.files) {
      const local = await realpath(join(options.root, candidate.relative)).catch(() => undefined);
      if (!local) {
        counts.missing++;
        continue;
      }
      const inside = relative(options.root, local);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        counts.outsideRoot++;
        continue;
      }
      const bytes = await this.#read(local);
      if (!bytes) {
        counts.missing++;
        continue;
      }
      if (bytes.length > MAX_FILE_BYTES)
        throw new SourcesError(`${candidate.relative} exceeds the 1 MiB source file limit`);

      let text: string;
      try {
        text = this.#decoder.decode(bytes);
      } catch {
        counts.nonUtf8++;
        continue;
      }
      if (counts.included >= MAX_FILES)
        throw new SourcesError("Sources exceed the 10000 file limit");
      if (counts.bytes + bytes.length > MAX_SOURCE_BYTES)
        throw new SourcesError("Sources exceed the 50 MiB total limit");
      if (text) lines += text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      if (lines > MAX_SOURCE_LINES)
        throw new SourcesError("Sources exceed the 1000000 total line limit");

      counts.included++;
      counts.bytes += bytes.length;
      files.push({ path: candidate.path, text });
    }

    return { files, counts };
  }
}
