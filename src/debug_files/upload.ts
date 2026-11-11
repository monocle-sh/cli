import type { NonSharedBuffer } from "node:buffer";

import ky, { isHTTPError, type HTTPError } from "ky";

export class NativeUploadError extends Error {}

type Prepared = {
  data: { files: Array<{ status: "exists" | "upload"; uploadUrl?: string; attemptId?: string }> };
};

const http = ky.create({
  // The symbolicator validates a debug file before `complete` answers.
  timeout: 150_000,
  retry: {
    limit: 2,
    methods: ["post", "put"],
    afterStatusCodes: [429],
    maxRetryAfter: 60_000,
    retryOnTimeout: true,
    delay: (attempt) => 1000 * 2 ** (attempt - 1),
    shouldRetry: ({ error }) =>
      isHTTPError(error)
        ? error.response.status === 429 || error.response.status >= 500
        : undefined,
  },
});

/**
 * Prepare, store and validate native artifacts with `/native-symbols/uploads`. A retried
 * prepare supersedes its earlier attempt, and `complete` is idempotent for one attempt.
 */
export class NativeUploader {
  constructor(
    protected options: { apiUrl: string; apiKey: string; release?: string; force?: boolean },
  ) {}

  #apiError(error: HTTPError): NativeUploadError {
    const status = error.response.status;
    if (status === 401 || status === 403)
      return new NativeUploadError(
        "Authentication failed. Use a project token with the Deploy scope, not the DSN.",
      );
    if (status === 404 && error.request.url.endsWith("/native-symbols/uploads"))
      return new NativeUploadError("This Monocle API does not accept debug files yet.");
    if (status === 429) return new NativeUploadError("Rate limited by Monocle. Try again later.");
    if (status >= 500)
      return new NativeUploadError(`Monocle server error (${status}). Try again later.`);

    const body = error.data as
      | { error?: unknown; message?: unknown; errors?: Array<{ message?: unknown }> }
      | undefined;
    const message = body?.errors?.[0]?.message ?? body?.message ?? body?.error;
    const detail = typeof message === "string" ? `: ${message.slice(0, 500)}` : "";

    return new NativeUploadError(`Monocle rejected the upload (${status})${detail}`);
  }

  #networkError(error: unknown): NativeUploadError {
    const host = new URL(this.options.apiUrl).host;
    if ((error as Error)?.name === "TimeoutError")
      return new NativeUploadError(`Request to ${host} timed out.`);

    return new NativeUploadError(`Could not reach ${host}. Check the API URL and your network.`);
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    try {
      return await http
        .post(`${this.options.apiUrl}${path}`, {
          headers: { "x-api-key": this.options.apiKey },
          json: body,
        })
        .json<T>();
    } catch (error) {
      if (isHTTPError(error)) throw this.#apiError(error);
      throw this.#networkError(error);
    }
  }

  async #put(url: string, body: NonSharedBuffer): Promise<void> {
    try {
      const response = await http.put(url, {
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      await response.body?.cancel();
    } catch (error) {
      if (!isHTTPError(error))
        throw new NativeUploadError("Could not reach Monocle storage. Check your network.");
      throw new NativeUploadError(`Monocle storage rejected the file (${error.response.status}).`);
    }
  }

  /**
   * Returns `exists` when Monocle already has a valid artifact for this build ID and kind.
   */
  async upload(input: {
    codeId: string;
    kind: "debug" | "sources";
    fileName: string;
    bytes: NonSharedBuffer;
  }): Promise<"uploaded" | "exists"> {
    const prepared = await this.#post<Prepared>("/native-symbols/uploads", {
      release: this.options.release,
      force: this.options.force,
      files: [
        {
          codeId: input.codeId,
          kind: input.kind,
          filePath: input.fileName,
          size: input.bytes.length,
        },
      ],
    });
    const file = prepared.data.files[0];
    if (file?.status === "exists") return "exists";
    if (file?.status !== "upload" || !file.uploadUrl || !file.attemptId)
      throw new NativeUploadError("Unexpected response from Monocle.");

    await this.#put(file.uploadUrl, input.bytes);
    const result = await this.#post<{ data: { status: string } }>(
      "/native-symbols/uploads/complete",
      { codeId: input.codeId, kind: input.kind, attemptId: file.attemptId },
    );
    if (result.data.status !== "ready")
      throw new NativeUploadError(`Monocle could not validate the ${input.kind} file.`);

    return "uploaded";
  }
}
