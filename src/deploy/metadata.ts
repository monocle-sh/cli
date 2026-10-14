import { detectServiceVersion } from "@monocle.sh/otel-utils/service-version";
import { DeploymentProvenance } from "./provenance.js";
import { CiDetector } from "./ci.js";
import type {
  DeploymentPayload,
  DeploymentReport,
  MetadataOptions,
  OptionalFieldsOptions,
} from "./types.js";

export class DeploymentValidationError extends Error {}

export class DeploymentMetadata {
  static #required(input: { value: string | undefined; field: string }): string {
    const { value, field } = input;
    if (!value?.trim()) throw new DeploymentValidationError(`Missing ${field}.`);

    return value.trim();
  }

  static #validate(payload: DeploymentPayload): void {
    if (!payload.version && !payload.commitSha) {
      throw new DeploymentValidationError(
        "Cannot detect a version. Provide --version or --commit.",
      );
    }
    if (!["started", "succeeded", "failed", "canceled"].includes(payload.status)) {
      throw new DeploymentValidationError(
        "Invalid --status. Use started, succeeded, failed, or canceled.",
      );
    }
    for (const field of ["startedAt", "finishedAt"] as const) {
      const value = payload[field];
      if (
        value &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
          !Number.isFinite(Date.parse(value)))
      ) {
        throw new DeploymentValidationError(
          `Invalid ${field}. Use an ISO 8601 timestamp with a timezone.`,
        );
      }
    }
    if (
      payload.startedAt &&
      payload.finishedAt &&
      Date.parse(payload.finishedAt) < Date.parse(payload.startedAt)
    ) {
      throw new DeploymentValidationError("finishedAt must not precede startedAt.");
    }
    if (payload.ciUrl) this.validateUrl({ value: payload.ciUrl, allowQuery: true });
  }

  static #optionalFields(input: OptionalFieldsOptions) {
    const { options, detected, ci, service, environment } = input;

    return {
      version: [options.version, detected.version, detected.source],
      commitSha: [
        options.commit,
        detected.commitSha,
        detected.commitSha
          ? DeploymentProvenance.detect({ ...input, field: "commitSha", value: detected.commitSha })
          : "none",
      ],
      repositoryUrl: [
        undefined,
        detected.repositoryUrl,
        detected.repositoryUrl
          ? DeploymentProvenance.detect({
              ...input,
              field: "repositoryUrl",
              value: detected.repositoryUrl,
            })
          : "none",
      ],
      externalId: [
        options.externalId,
        ci.externalId ? `${ci.externalId}:${service}:${environment}` : undefined,
        ci.source,
      ],
      actor: [options.actor, ci.actor, ci.source],
      ciUrl: [options.ciUrl, ci.ciUrl, ci.source],
      startedAt: [options.startedAt, undefined, "none"],
      finishedAt: [options.finishedAt, undefined, "none"],
    } as const;
  }

  static validateUrl(input: { value: string; allowQuery?: boolean }): string {
    try {
      const url = new URL(input.value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        (!input.allowQuery && (url.search || url.hash))
      )
        throw new Error();

      return url.toString().replace(/\/$/, "");
    } catch {
      throw new DeploymentValidationError(
        "Use an HTTP(S) URL without credentials, query, or fragment.",
      );
    }
  }

  static resolve(input: MetadataOptions): DeploymentReport {
    const { options } = input;
    const env = input.env ?? process.env;
    const service = this.#required({ value: options.service, field: "--service" });
    const environment = this.#required({
      value: options.environment ?? env.MONOCLE_ENVIRONMENT,
      field: "--environment or MONOCLE_ENVIRONMENT",
    });
    const detected = detectServiceVersion({ env, cwd: input.cwd });
    const ci = CiDetector.detect(env);
    const payload: DeploymentPayload = {
      service,
      environment,
      status: options.status ?? "succeeded",
    };
    const provenance: DeploymentReport["provenance"] = {
      service: "flag",
      environment: options.environment !== undefined ? "flag" : "env",
      status: options.status !== undefined ? "flag" : "default",
    };
    const fields = this.#optionalFields({ ...input, detected, ci, service, environment });
    for (const [field, [flag, fallback, source]] of Object.entries(fields)) {
      const value = flag ?? fallback;
      if (value === undefined) continue;
      if (!value.trim()) throw new DeploymentValidationError(`Empty ${field}.`);
      const key = field as keyof typeof fields;
      payload[key] = value;
      provenance[key] = flag !== undefined ? "flag" : source;
    }
    this.#validate(payload);

    return { payload, provenance };
  }
}
