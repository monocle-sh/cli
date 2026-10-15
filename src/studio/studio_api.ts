import ky, { type KyInstance } from "ky";
import pc from "picocolors";

/**
 * HTTP client for the Monocle Studio local server.
 * Wraps ky to query traces, logs, and exceptions from the running instance.
 */
export class StudioApi {
  #client: KyInstance;

  constructor(port: number) {
    this.#client = ky.create({
      prefix: `http://localhost:${port}`,
    });
  }

  /**
   * Fetch traces from the Studio server.
   */
  async traces(params: { limit?: string; service?: string; traceId?: string } = {}) {
    return this.#fetch<any[]>("api/traces", params);
  }

  /**
   * Fetch logs from the Studio server.
   */
  async logs(
    params: { limit?: string; severity?: string; search?: string; traceId?: string } = {},
  ) {
    return this.#fetch<any[]>("api/logs", params);
  }

  /**
   * Fetch exceptions from the Studio server.
   */
  async exceptions(params: { limit?: string; traceId?: string } = {}) {
    return this.#fetch<any[]>("api/exceptions", params);
  }

  /**
   * Generic GET request against the Studio API.
   * Filters out undefined params and exits the process on connection failure.
   */
  async #fetch<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const searchParams = Object.fromEntries(
      Object.entries(params).filter((entry): entry is [string, string] => !!entry[1]),
    );

    try {
      const result = await this.#client.get(path, { searchParams }).json<{ data: T }>();
      return result.data;
    } catch {
      console.error(pc.red(`Could not connect to Monocle Studio`));
      console.error(pc.dim(`Make sure the server is running: monocle studio dev`));
      process.exit(1);
    }
  }
}
