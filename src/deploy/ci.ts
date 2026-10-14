import type { CiMetadata } from "./types.js";

export class CiDetector {
  static #github(env: NodeJS.ProcessEnv): CiMetadata | undefined {
    if (!env.GITHUB_RUN_ID || !env.GITHUB_REPOSITORY) return;

    return {
      source: "ci:github",
      externalId: `github:${env.GITHUB_REPOSITORY}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT || "1"}`,
      actor: env.GITHUB_ACTOR || undefined,
      ciUrl: `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    };
  }

  static #gitlab(env: NodeJS.ProcessEnv): CiMetadata | undefined {
    if (!env.CI_PIPELINE_ID || !env.CI_JOB_ID || !(env.CI_PROJECT_PATH || env.CI_PROJECT_ID))
      return;

    return {
      source: "ci:gitlab",
      externalId: `gitlab:${env.CI_PROJECT_PATH || env.CI_PROJECT_ID}:${env.CI_PIPELINE_ID}:${env.CI_JOB_ID}`,
      actor: env.GITLAB_USER_LOGIN || undefined,
      ciUrl: env.CI_JOB_URL || env.CI_PIPELINE_URL || undefined,
    };
  }

  static #circleci(env: NodeJS.ProcessEnv): CiMetadata | undefined {
    if (!env.CIRCLE_WORKFLOW_ID) return;

    return {
      source: "ci:circleci",
      externalId: `circleci:${env.CIRCLE_WORKFLOW_ID}`,
      actor: env.CIRCLE_USERNAME || undefined,
      ciUrl: env.CIRCLE_BUILD_URL || undefined,
    };
  }

  static #buildkite(env: NodeJS.ProcessEnv): CiMetadata | undefined {
    if (!env.BUILDKITE_BUILD_ID || !env.BUILDKITE_JOB_ID) return;

    return {
      source: "ci:buildkite",
      externalId: `buildkite:${env.BUILDKITE_BUILD_ID}:${env.BUILDKITE_JOB_ID}:${env.BUILDKITE_RETRY_COUNT || "0"}`,
      actor: env.BUILDKITE_BUILD_CREATOR || undefined,
      ciUrl: env.BUILDKITE_BUILD_URL || undefined,
    };
  }

  static #bitbucket(env: NodeJS.ProcessEnv): CiMetadata | undefined {
    if (!env.BITBUCKET_PIPELINE_UUID || !env.BITBUCKET_REPO_FULL_NAME) return;

    return {
      source: "ci:bitbucket",
      externalId: `bitbucket:${env.BITBUCKET_REPO_FULL_NAME}:${env.BITBUCKET_PIPELINE_UUID}:${env.BITBUCKET_STEP_RUN_NUMBER || "1"}`,
      actor: env.BITBUCKET_STEP_TRIGGERER_UUID || undefined,
      ciUrl: env.BITBUCKET_BUILD_NUMBER
        ? `https://bitbucket.org/${env.BITBUCKET_REPO_FULL_NAME}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}`
        : undefined,
    };
  }

  static detect(env: NodeJS.ProcessEnv): CiMetadata {
    return (
      this.#github(env) ??
      this.#gitlab(env) ??
      this.#circleci(env) ??
      this.#buildkite(env) ??
      this.#bitbucket(env) ?? { source: "none" }
    );
  }
}
