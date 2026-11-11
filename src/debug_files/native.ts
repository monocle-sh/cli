import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type Inspection = {
  codeId: string | null;
  hasDebugInfo: boolean;
  /**
   * DWARF source files beneath the prefix: `path` is the DWARF key, `relative` the path under the root
   */
  files: Array<{ path: string; relative: string }>;
  outsidePrefix: number;
  duplicates: number;
  nonUtf8: number;
};

type Exports = {
  memory: WebAssembly.Memory;
  alloc(length: number): number;
  dealloc(pointer: number, length: number): void;
  inspect(data: number, dataLength: number, prefix: number, prefixLength: number): number;
  bundle(input: number, length: number): number;
};

export class NativeModuleError extends Error {}

/**
 * symbolic, the library of the Monocle symbolicator, compiled to WebAssembly from `native/`.
 * Loaded on first use, so other commands never pay for it.
 */
export class NativeModule {
  static #instance?: Promise<Exports>;

  static #load(): Promise<Exports> {
    this.#instance ??= (async () => {
      try {
        const path = fileURLToPath(import.meta.resolve("@monocle.sh/cli/monocle_native.wasm"));
        const { instance } = await WebAssembly.instantiate(await readFile(path), {});
        return instance.exports as unknown as Exports;
      } catch {
        throw new NativeModuleError(
          "could not load monocle_native.wasm. Reinstall @monocle.sh/cli.",
        );
      }
    })();

    return this.#instance;
  }

  static #write(wasm: Exports, bytes: Uint8Array): number {
    const pointer = wasm.alloc(bytes.length);
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);

    return pointer;
  }

  /**
   * Reads `[status][u32 length][payload]`, copies the payload out of wasm memory and frees it.
   */
  static #read(wasm: Exports, pointer: number): Buffer {
    const view = new DataView(wasm.memory.buffer);
    const status = view.getUint8(pointer);
    const length = view.getUint32(pointer + 1, true);
    const payload = Buffer.from(new Uint8Array(wasm.memory.buffer, pointer + 5, length));
    wasm.dealloc(pointer, length + 5);
    if (status !== 0) throw new NativeModuleError(payload.toString("utf8"));

    return payload;
  }

  /**
   * Build ID and debug info presence. With a prefix, also the DWARF source files beneath it.
   */
  static async inspect(options: { bytes: Uint8Array; prefix?: string }): Promise<Inspection> {
    const wasm = await this.#load();
    const prefix = Buffer.from(options.prefix ?? "", "utf8");
    const result = wasm.inspect(
      this.#write(wasm, options.bytes),
      options.bytes.length,
      this.#write(wasm, prefix),
      prefix.length,
    );

    return JSON.parse(this.#read(wasm, result).toString("utf8")) as Inspection;
  }

  /**
   * A symbolic source bundle, the format the symbolicator reads code excerpts from.
   */
  static async bundle(options: {
    codeId: string;
    files: Array<{ path: string; text: string }>;
  }): Promise<Buffer> {
    const wasm = await this.#load();
    const input = Buffer.from(JSON.stringify(options), "utf8");

    return this.#read(wasm, wasm.bundle(this.#write(wasm, input), input.length));
  }
}
