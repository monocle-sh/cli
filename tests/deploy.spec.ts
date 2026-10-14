import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "@japa/runner";
import { CiDetector } from "../src/deploy/ci.js";
import { DeploymentMetadata } from "../src/deploy/metadata.js";
import { DeploymentClient } from "../src/deploy/client.js";

type RunOptions = { args?: string[]; env?: NodeJS.ProcessEnv; cwd?: string };

class DeployTest {
  static async run(options: RunOptions = {}) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("@poppinss/ts-exec"),
        resolve(import.meta.dirname, "../src/cli.ts"),
        "deploy",
        ...(options.args ?? []),
      ],
      {
        cwd: options.cwd ?? resolve(import.meta.dirname, ".."),
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    return { code, stdout, stderr };
  }

  static async server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port");

    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
}

test.group("deployment CI metadata", () => {
  const cases = [
    {
      source: "github",
      env: {
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: "acme/shop",
        GITHUB_ACTOR: "alice",
        GITHUB_SHA: "a".repeat(40),
      },
      retry: { GITHUB_RUN_ATTEMPT: "2" },
      actor: "alice",
    },
    {
      source: "gitlab",
      env: {
        CI_PIPELINE_ID: "42",
        CI_JOB_ID: "8",
        CI_PROJECT_PATH: "acme/shop",
        CI_JOB_URL: "https://gitlab.com/job/8",
        GITLAB_USER_LOGIN: "alice",
        CI_COMMIT_SHA: "a".repeat(40),
        CI_PROJECT_URL: "https://gitlab.com/acme/shop",
      },
      retry: { CI_JOB_ID: "9" },
      actor: "alice",
    },
    {
      source: "circleci",
      env: {
        CIRCLE_WORKFLOW_ID: "workflow-1",
        CIRCLE_USERNAME: "alice",
        CIRCLE_BUILD_URL: "https://circleci.com/job/8",
        CIRCLE_SHA1: "a".repeat(40),
        CIRCLE_REPOSITORY_URL: "git@github.com:acme/shop.git",
      },
      retry: { CIRCLE_WORKFLOW_ID: "workflow-2" },
      actor: "alice",
    },
    {
      source: "buildkite",
      env: {
        BUILDKITE_BUILD_ID: "build-1",
        BUILDKITE_JOB_ID: "job-1",
        BUILDKITE_BUILD_CREATOR: "alice",
        BUILDKITE_BUILD_URL: "https://buildkite.com/acme/shop/1",
        BUILDKITE_COMMIT: "a".repeat(40),
        BUILDKITE_REPO: "git@github.com:acme/shop.git",
      },
      retry: { BUILDKITE_JOB_ID: "job-2", BUILDKITE_RETRY_COUNT: "1" },
      actor: "alice",
    },
    {
      source: "bitbucket",
      env: {
        BITBUCKET_PIPELINE_UUID: "pipeline-1",
        BITBUCKET_REPO_FULL_NAME: "acme/shop",
        BITBUCKET_BUILD_NUMBER: "42",
        BITBUCKET_STEP_TRIGGERER_UUID: "alice",
        BITBUCKET_COMMIT: "a".repeat(40),
      },
      retry: { BITBUCKET_STEP_RUN_NUMBER: "2" },
      actor: "alice",
    },
  ];
  for (const fixture of cases) {
    test(`${fixture.source}: metadata, stable identity and distinct retries`, ({ assert }) => {
      const env = fixture.env as NodeJS.ProcessEnv;
      const options = { service: "api", environment: "production", status: "started" };
      const started = DeploymentMetadata.resolve({ options, env });
      const finished = DeploymentMetadata.resolve({
        options: { ...options, status: "succeeded" },
        env,
      });
      const retry = DeploymentMetadata.resolve({ options, env: { ...env, ...fixture.retry } });
      assert.equal(started.payload.externalId, finished.payload.externalId);
      assert.notEqual(started.payload.externalId, retry.payload.externalId);
      assert.equal(started.payload.actor, fixture.actor);
      assert.equal(started.payload.commitSha, "a".repeat(40));
      assert.notProperty(started.payload, "version");
      assert.equal(started.provenance.commitSha, `ci:${fixture.source}`);
      assert.equal(started.provenance.repositoryUrl, `ci:${fixture.source}`);
      assert.equal(started.provenance.externalId, `ci:${fixture.source}`);
      assert.match(started.payload.ciUrl!, /^https:\/\//);
      assert.isDefined(started.payload.repositoryUrl);
    });
  }

  for (const fixture of cases) {
    test(`${fixture.source}: empty optional CI values are ignored`, ({ assert }) => {
      const env = Object.fromEntries(
        Object.entries(fixture.env).map(([key, value]) => [
          key,
          /ACTOR|LOGIN|USERNAME|CREATOR|TRIGGERER|URL/.test(key) ? "" : value,
        ]),
      );
      const ci = CiDetector.detect(env);
      assert.isUndefined(ci.actor);
      assert.notEqual(ci.ciUrl, "");
      const report = DeploymentMetadata.resolve({
        options: { service: "api", environment: "prod" },
        env,
      });
      assert.notProperty(report.payload, "actor");
    });
  }

  test("GitHub identity includes repository, attempt, service and environment", ({ assert }) => {
    const report = DeploymentMetadata.resolve({
      options: { service: "api", environment: "production" },
      env: cases[0].env,
    });
    assert.equal(report.payload.externalId, "github:acme/shop:42:1:api:production");
  });

  test("outside CI, each invocation gets a unique external identity", ({ assert }) => {
    assert.deepEqual(CiDetector.detect({}), { source: "none" });
    const report = DeploymentMetadata.resolve({
      options: { service: "api", environment: "prod", version: "2.0.0" },
      env: {},
    });
    assert.match(report.payload.externalId!, /^cli:[0-9a-f-]{36}:api:prod$/);
    assert.equal(report.provenance.externalId, "generated");
    const next = DeploymentMetadata.resolve({
      options: { service: "api", environment: "prod", version: "2.0.0" },
      env: {},
    });
    assert.notEqual(next.payload.externalId, report.payload.externalId);
    assert.equal(report.provenance.commitSha, "git");
    assert.equal(report.provenance.status, "default");
  });

  test("flags override environment and CI with accurate provenance", ({ assert }) => {
    const options = {
      service: "api",
      environment: "staging",
      version: "3.0.0",
      commit: "b".repeat(40),
      externalId: "custom",
      actor: "bob",
      ciUrl: "https://ci.example.com/1",
      status: "failed",
      startedAt: "2026-10-14T12:00:00Z",
      finishedAt: "2026-10-14T12:01:00Z",
    };
    const report = DeploymentMetadata.resolve({
      options,
      env: { ...cases[0].env, MONOCLE_ENVIRONMENT: "prod" },
    });
    assert.equal(report.payload.version, "3.0.0");
    assert.equal(report.payload.environment, "staging");
    assert.equal(report.payload.externalId, "custom");
    for (const key of [
      "version",
      "commitSha",
      "actor",
      "ciUrl",
      "externalId",
      "startedAt",
      "finishedAt",
      "status",
    ] as const)
      assert.equal(report.provenance[key], "flag");
  });

  test("version and environment use env defaults", ({ assert }) => {
    const report = DeploymentMetadata.resolve({
      options: { service: "api" },
      env: { MONOCLE_VERSION: "2.1.0", MONOCLE_ENVIRONMENT: "prod", GITHUB_SHA: "a".repeat(40) },
    });
    assert.equal(report.payload.version, "2.1.0");
    assert.equal(report.provenance.version, "env");
    assert.equal(report.provenance.environment, "env");
    assert.equal(report.provenance.commitSha, "ci:github");
  });

  test("requires version or commit when detection has no result", ({ assert }) => {
    const cwd = mkdtempSync(join(tmpdir(), "deploy-no-git-"));
    try {
      assert.throws(
        () =>
          DeploymentMetadata.resolve({
            options: { service: "api", environment: "prod" },
            env: {},
            cwd,
          }),
        /Cannot detect/,
      );
      const report = DeploymentMetadata.resolve({
        options: { service: "api", environment: "prod", commit: "a".repeat(40) },
        env: {},
        cwd,
      });
      assert.notProperty(report.payload, "version");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test.group("deployment HTTP and command", () => {
  for (const status of [200, 201, 202, 401, 403, 422, 500, 503]) {
    test(`HTTP ${status}: payload, retries and exit codes`, async ({ assert }) => {
      let calls = 0;
      const requests: unknown[] = [];
      const server = await DeployTest.server((request, response) => {
        calls++;
        assert.equal(request.url, "/api/v1/deployments");
        assert.equal(request.method, "POST");
        assert.equal(request.headers["x-api-key"], "secret-api-key");
        assert.match(request.headers["user-agent"] ?? "", /^monocle-cli\//);
        let body = "";
        request.on("data", (data) => {
          body += data;
        });
        request.on("end", () => {
          requests.push(JSON.parse(body));
          response.writeHead(status, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              availableEnvironments: ["prod", "staging", "secret-api-key"],
              message: "secret-api-key",
            }),
          );
        });
      });
      try {
        for (const strict of [false, true]) {
          const result = await DeployTest.run({
            args: [
              "--service",
              "api",
              "--environment",
              "prod",
              "--version",
              "2.0.0",
              "--url",
              server.url,
              ...(strict ? ["--strict"] : []),
            ],
            env: { MONOCLE_API_KEY: "secret-api-key" },
          });
          assert.equal(result.code, strict && status >= 400 ? 1 : 0);
          assert.notInclude(result.stdout + result.stderr, "secret-api-key");
          if (status >= 400) assert.include(result.stderr, strict ? "Error:" : "Warning:");
          if (status === 422)
            assert.include(result.stderr, "Available environments: prod, staging");
          if (status === 202) assert.include(result.stdout, "without storage");
        }
        assert.equal(calls, status >= 500 ? 4 : 2);
        assert.equal((requests[0] as { version: string }).version, "2.0.0");
        if (status >= 500) assert.deepEqual(requests[0], requests[1]);
      } finally {
        await server.close();
      }
    }).timeout(15000);
  }

  test("retries a dropped connection and succeeds", async ({ assert }) => {
    let calls = 0;
    const server = await DeployTest.server((request, response) => {
      if (++calls === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(201).end();
    });
    try {
      const status = await DeploymentClient.send({
        url: server.url,
        apiKey: "key",
        payload: { service: "api", environment: "prod", version: "2", status: "succeeded" },
        userAgent: "monocle-cli/test",
      });
      assert.equal(status, 201);
      assert.equal(calls, 2);
    } finally {
      await server.close();
    }
  });

  test("network failures retry once and respect strict mode", async ({ assert }) => {
    let calls = 0;
    const server = await DeployTest.server((request) => {
      calls++;
      request.socket.destroy();
    });
    try {
      for (const strict of [false, true]) {
        const result = await DeployTest.run({
          args: [
            "--service",
            "api",
            "--environment",
            "prod",
            "--api-key",
            "secret",
            "--url",
            server.url,
            ...(strict ? ["--strict"] : []),
          ],
        });
        assert.equal(result.code, strict ? 1 : 0);
        assert.include(result.stderr, strict ? "Error:" : "Warning:");
        assert.notInclude(result.stderr, "secret");
      }
      assert.equal(calls, 4);
    } finally {
      await server.close();
    }
  }).timeout(15000);

  test("timeouts stop after one retry", async ({ assert }) => {
    let calls = 0;
    const server = await DeployTest.server(() => {
      calls++;
    });
    const started = Date.now();
    try {
      const result = await DeployTest.run({
        args: [
          "--service",
          "api",
          "--environment",
          "prod",
          "--api-key",
          "secret",
          "--url",
          server.url,
          "--strict",
        ],
      });
      assert.equal(result.code, 1);
      assert.include(result.stderr, "timed out");
      assert.equal(calls, 2);
      assert.isBelow(Date.now() - started, 15000);
    } finally {
      await server.close();
    }
  }).timeout(18000);

  test("dry run needs no key, sends nothing and reports provenance", async ({ assert }) => {
    let calls = 0;
    const server = await DeployTest.server((_request, response) => {
      calls++;
      response.end();
    });
    try {
      const result = await DeployTest.run({
        args: ["--service", "api", "--version", "2.0.0", "--dry-run", "--url", server.url],
        env: { MONOCLE_ENVIRONMENT: "prod" },
      });
      assert.equal(result.code, 0);
      const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
      assert.equal(report.provenance.version, "flag");
      assert.equal(report.provenance.environment, "env");
      assert.equal(report.provenance.status, "default");
      assert.equal(calls, 0);
    } finally {
      await server.close();
    }
  });

  test("usage errors always exit 1", async ({ assert }) => {
    for (const args of [
      [],
      ["--service", "api"],
      ["--service", "api", "--environment", "prod", "--status", "bad"],
      ["--service", "api", "--environment", "prod", "--started-at", "yesterday"],
      ["--service", "api", "--environment", "prod", "--actor", ""],
      ["--service", "api", "--environment", "prod", "--version", ""],
      ["--service", "api", "--environment", "prod", "--api-key", ""],
    ]) {
      for (const strict of [false, true]) {
        const result = await DeployTest.run({ args: [...args, ...(strict ? ["--strict"] : [])] });
        assert.equal(result.code, 1);
        assert.include(result.stderr, "Error:");
      }
    }
  }).timeout(20000);

  test("missing API key or revision respects strict mode", async ({ assert }) => {
    const cwd = mkdtempSync(join(tmpdir(), "deploy-command-no-git-"));
    try {
      for (const strict of [false, true]) {
        for (const version of [undefined, "2.0.0"]) {
          const result = await DeployTest.run({
            cwd,
            args: [
              "--service",
              "api",
              "--environment",
              "prod",
              ...(version ? ["--version", version] : []),
              ...(strict ? ["--strict"] : []),
            ],
          });
          assert.equal(result.code, strict ? 1 : 0);
          assert.include(result.stderr, strict ? "Error:" : "Warning:");
          assert.include(result.stderr, version ? "Missing --api-key" : "Cannot detect a version");
        }
      }
      for (const args of [
        ["--status", "bad"],
        ["--started-at", "yesterday"],
      ]) {
        const result = await DeployTest.run({
          cwd,
          args: ["--service", "api", "--environment", "prod", ...args],
        });
        assert.equal(result.code, 1);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }).timeout(20000);

  test("dry run sends detected SHA only as commitSha", async ({ assert }) => {
    const result = await DeployTest.run({
      args: ["--service", "api", "--environment", "prod", "--dry-run"],
      env: { VERCEL_GIT_COMMIT_SHA: "a".repeat(40) },
    });
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    assert.notProperty(report.payload, "version");
    assert.notProperty(report.provenance, "version");
    assert.equal(report.payload.commitSha, "a".repeat(40));
    assert.equal(report.provenance.commitSha, "platform:vercel");
  });

  test("timeout retry outside CI reuses the generated identity", async ({ assert }) => {
    const requests: { externalId: string }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = await DeployTest.server((request, response) => {
      let body = "";
      request.on("data", (data) => {
        body += data;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        if (requests.length === 1) {
          timer = setTimeout(() => response.writeHead(201).end(), 6000);
          return;
        }
        response.writeHead(200).end();
      });
    });
    try {
      const result = await DeployTest.run({
        args: [
          "--service",
          "api",
          "--environment",
          "prod",
          "--version",
          "2.0.0",
          "--api-key",
          "secret",
          "--url",
          server.url,
          "--strict",
        ],
      });
      assert.equal(result.code, 0);
      assert.equal(requests.length, 2);
      assert.match(requests[0].externalId, /^cli:[0-9a-f-]{36}:api:prod$/);
      assert.deepEqual(requests[0], requests[1]);
    } finally {
      clearTimeout(timer);
      await server.close();
    }
  }).timeout(15000);

  test("API keys are redacted even when echoed in the dry-run payload", async ({ assert }) => {
    const result = await DeployTest.run({
      args: ["--service", "api", "--environment", "prod", "--version", "secret", "--dry-run"],
      env: { MONOCLE_API_KEY: "secret" },
    });
    assert.equal(result.code, 0);
    assert.notInclude(result.stdout + result.stderr, "secret");
    assert.include(result.stdout, "[REDACTED]");
  });
});
