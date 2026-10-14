import type { ServiceVersion } from "@monocle.sh/otel-utils/service-version";

export type DeployOptions = {
  service?: string;
  environment?: string;
  version?: string;
  commit?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  externalId?: string;
  actor?: string;
  ciUrl?: string;
  apiKey?: string;
  url?: string;
  strict?: boolean;
  dryRun?: boolean;
};

export type DeploymentPayload = {
  service: string;
  environment: string;
  version?: string;
  commitSha?: string;
  repositoryUrl?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  externalId?: string;
  actor?: string;
  ciUrl?: string;
};

export type CiMetadata = {
  source: string;
  externalId?: string;
  actor?: string;
  ciUrl?: string;
};

export type MetadataOptions = {
  options: DeployOptions;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type DeploymentReport = {
  payload: DeploymentPayload;
  provenance: Partial<Record<keyof DeploymentPayload, string>>;
};

export type MetadataSourceOptions = MetadataOptions & {
  field: "commitSha" | "repositoryUrl";
  value: string;
};

export type OptionalFieldsOptions = MetadataOptions & {
  detected: ServiceVersion;
  ci: CiMetadata;
  service: string;
  environment: string;
};
