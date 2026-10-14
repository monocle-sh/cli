import ky, { HTTPError, TimeoutError } from "ky";
import type { DeploymentPayload } from "./types.js";

export type DeploymentRequest = {
  url: string;
  apiKey: string;
  payload: DeploymentPayload;
};

export class DeploymentRequestError extends Error {}

export class DeploymentClient {
  static #slugs(body: unknown): string[] {
    if (!body || typeof body !== "object") return [];

    const data = body as Record<string, unknown>;
    const candidates =
      data.availableEnvironments ??
      data.available_environments ??
      data.environments ??
      data.availableSlugs;
    if (!Array.isArray(candidates)) return this.#slugs(data.error ?? data.data);

    return candidates
      .flatMap((entry) => {
        const slug = typeof entry === "string" ? entry : entry?.slug;
        if (typeof slug !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(slug)) return [];

        return [slug];
      })
      .slice(0, 50);
  }

  static async #error(error: unknown): Promise<DeploymentRequestError> {
    if (error instanceof TimeoutError)
      return new DeploymentRequestError("Deployment request timed out.");
    if (!(error instanceof HTTPError))
      return new DeploymentRequestError(
        "Deployment request failed. Check your network connection.",
      );

    const status = error.response.status;
    if (status === 401 || status === 403)
      return new DeploymentRequestError(
        "Authentication failed. Use a private application API key of type full.",
      );
    if (status === 422) {
      const body = await error.response.json().catch(() => undefined);
      const slugs = this.#slugs(body);

      return new DeploymentRequestError(
        `Deployment rejected (422). Check the payload.${slugs.length ? ` Available environments: ${slugs.join(", ")}.` : ""}`,
      );
    }
    if (status >= 500)
      return new DeploymentRequestError(`Deployment server error (${status}). Try again later.`);

    return new DeploymentRequestError(`Deployment request failed (${status}).`);
  }

  static async send(input: DeploymentRequest): Promise<number> {
    try {
      const response = await ky.post(`${input.url}/api/v1/deployments`, {
        headers: { "x-api-key": input.apiKey },
        json: input.payload,
        timeout: 5000,
        signal: AbortSignal.timeout(11_000),
        redirect: "error",
        retry: {
          limit: 1,
          methods: ["post"],
          statusCodes: Array.from({ length: 100 }, (_, index) => 500 + index),
          afterStatusCodes: [],
          retryOnTimeout: true,
          delay: () => 300,
        },
      });
      if (![200, 201, 202].includes(response.status)) {
        throw new DeploymentRequestError(`Unexpected deployment response (${response.status}).`);
      }

      return response.status;
    } catch (error) {
      if (error instanceof DeploymentRequestError) throw error;

      throw await this.#error(error);
    }
  }
}
