import { detectServiceVersion } from "@monocle.sh/otel-utils/service-version";
import type { MetadataSourceOptions } from "./types.js";

export class DeploymentProvenance {
  static detect(input: MetadataSourceOptions): string {
    const env = input.env ?? process.env;
    // Resolve provenance through the shared detector, including repository sanitization.
    const groups: Record<string, string[]> = {
      env: ["MONOCLE_VERSION"],
      "platform:vercel": ["VERCEL_"],
      "platform:render": ["RENDER_"],
      "platform:railway": ["RAILWAY_"],
      "platform:heroku": ["HEROKU_"],
      "platform:coolify": ["SOURCE_COMMIT"],
      "platform:dokku": ["GIT_REV"],
      "platform:cloud-run": ["K_REVISION"],
      "ci:github": ["GITHUB_"],
      "ci:gitlab": ["CI_", "GITLAB_CI"],
      "ci:circleci": ["CIRCLE"],
      "ci:bitbucket": ["BITBUCKET_"],
      "ci:buildkite": ["BUILDKITE"],
    };
    for (const [source, prefixes] of Object.entries(groups)) {
      const subset = Object.fromEntries(
        Object.entries(env).filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix))),
      );
      if (!Object.keys(subset).length) continue;
      const detected = detectServiceVersion({ env: subset, cwd: input.cwd });
      if (detected[input.field] !== input.value) continue;
      if (
        input.field === "commitSha" &&
        !Object.values(subset).some((value) => value?.trim() === input.value)
      )
        continue;

      return source;
    }

    return input.field === "commitSha" ? "git" : "env";
  }
}
