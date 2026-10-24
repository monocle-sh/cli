import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "@japa/runner";

const SNIPPET_START = ';!function(){try{var e="undefined"!=typeof window?window:';

class SourcemapsTest {
  static async run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("@poppinss/ts-exec"),
        resolve(import.meta.dirname, "../src/cli.ts"),
        "sourcemaps",
        ...args,
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", ...env },
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

  /**
   * A build directory with two minified files and their maps, plus one file without a map.
   */
  static build(): string {
    const directory = mkdtempSync(join(tmpdir(), "monocle-cli-sourcemaps-"));
    const files = ["assets/index-a1b2.js", "assets/chunks/vendor-c3d4.js"];
    for (const [index, file] of files.entries()) {
      const name = file.split("/").at(-1);
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(
        join(directory, file),
        `console.log(${index});\n//# sourceMappingURL=${name}.map\n`,
      );
      writeFileSync(
        join(directory, `${file}.map`),
        JSON.stringify({ version: 3, sources: [`src/${index}.ts`], names: [], mappings: "AAAA" }),
      );
    }
    writeFileSync(join(directory, "assets/no-map.js"), "console.log('plain')\n");

    return directory;
  }

  static async api(handler?: (request: IncomingMessage, response: ServerResponse) => boolean) {
    const batches: any[] = [];
    const puts = new Map<string, Buffer>();
    const completed: string[][] = [];
    const keys: Array<string | undefined> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      if (handler?.(request, response)) return;

      const json = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url === "/sourcemaps/uploads") {
        keys.push(request.headers["x-api-key"] as string | undefined);
        const payload = JSON.parse(body.toString());
        batches.push(payload);
        return json({
          data: {
            files: payload.files.map(({ debugId }: { debugId: string }) => ({
              debugId,
              status: "upload",
              minifiedUploadUrl: `${url}/put/${debugId}/minified`,
              mapUploadUrl: `${url}/put/${debugId}/map`,
            })),
          },
        });
      }
      if (request.url!.startsWith("/put/")) {
        puts.set(request.url!, gunzipSync(body));
        response.writeHead(200);
        return response.end();
      }
      if (request.url === "/sourcemaps/uploads/complete") {
        const { debugIds } = JSON.parse(body.toString());
        completed.push(debugIds);
        return json({
          data: { files: debugIds.map((debugId: string) => ({ debugId, status: "ready" })) },
        });
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port");
    const url = `http://127.0.0.1:${address.port}`;

    return {
      url,
      batches,
      puts,
      completed,
      keys,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
}

test.group("sourcemaps inject", (group) => {
  let directory: string;

  group.each.setup(() => {
    directory = SourcemapsTest.build();
    return () => rmSync(directory, { recursive: true, force: true });
  });

  test("injects debug IDs into files with source maps and is idempotent", async ({ assert }) => {
    const first = await SourcemapsTest.run(["inject", directory]);

    assert.equal(first.code, 0, first.stderr);
    assert.include(first.stdout, "Injected debug IDs into 2 file(s)");
    const code = readFileSync(join(directory, "assets/index-a1b2.js"), "utf8");
    const debugId = /^\/\/# debugId=([0-9a-f-]{36})$/m.exec(code)?.[1];
    assert.isString(debugId);
    assert.isTrue(code.startsWith(SNIPPET_START));
    assert.include(first.stdout, `assets/index-a1b2.js ${debugId}`);
    const map = JSON.parse(readFileSync(join(directory, "assets/index-a1b2.js.map"), "utf8"));
    assert.equal(map.debugId, debugId);
    assert.equal(
      readFileSync(join(directory, "assets/no-map.js"), "utf8"),
      "console.log('plain')\n",
    );

    const second = await SourcemapsTest.run(["inject", directory]);
    assert.equal(second.code, 0, second.stderr);
    assert.include(second.stdout, "Injected debug IDs into 0 file(s) (2 already injected)");
    assert.equal(readFileSync(join(directory, "assets/index-a1b2.js"), "utf8"), code);
  });

  test("exits with code 1 when no file has a source map", async ({ assert }) => {
    const empty = mkdtempSync(join(tmpdir(), "monocle-cli-sourcemaps-"));
    writeFileSync(join(empty, "index.js"), "console.log(1)\n");
    try {
      const result = await SourcemapsTest.run(["inject", empty]);
      assert.equal(result.code, 1);
      assert.include(result.stderr, "Error: Nothing to inject");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("exits with code 1 for a missing directory", async ({ assert }) => {
    const result = await SourcemapsTest.run(["inject", join(directory, "missing")]);

    assert.equal(result.code, 1);
    assert.include(result.stderr, "Error: Directory not found");
  });
});

test.group("sourcemaps upload", (group) => {
  let directory: string;

  group.each.setup(() => {
    directory = SourcemapsTest.build();
    return () => rmSync(directory, { recursive: true, force: true });
  });

  test("uploads injected files with the API key from the environment", async ({ assert }) => {
    const api = await SourcemapsTest.api();
    try {
      await SourcemapsTest.run(["inject", directory]);
      const result = await SourcemapsTest.run(
        ["upload", directory, "--url", api.url, "--release", "v1.2.3"],
        { MONOCLE_API_KEY: "env-key" },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.include(result.stdout, "Uploaded 2 source map(s) for release v1.2.3");
      assert.deepEqual(api.keys, ["env-key"]);
      assert.equal(api.batches[0].release, "v1.2.3");
      assert.deepEqual(api.batches[0].files.map((file: any) => file.filePath).sort(), [
        "assets/chunks/vendor-c3d4.js",
        "assets/index-a1b2.js",
      ]);
      assert.equal(api.puts.size, 4);
      assert.lengthOf(api.completed[0]!, 2);
      const code = readFileSync(join(directory, "assets/index-a1b2.js"));
      const debugId = /^\/\/# debugId=([0-9a-f-]{36})$/m.exec(code.toString())![1];
      assert.deepEqual(api.puts.get(`/put/${debugId}/minified`), code);
    } finally {
      await api.close();
    }
  });

  test("--api-key wins over MONOCLE_API_KEY", async ({ assert }) => {
    const api = await SourcemapsTest.api();
    try {
      await SourcemapsTest.run(["inject", directory]);
      const result = await SourcemapsTest.run(
        ["upload", directory, "--url", api.url, "--api-key", "flag-key"],
        { MONOCLE_API_KEY: "env-key" },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(api.keys, ["flag-key"]);
    } finally {
      await api.close();
    }
  });

  test("refuses files that were not injected, with a hint", async ({ assert }) => {
    const api = await SourcemapsTest.api();
    try {
      const result = await SourcemapsTest.run(["upload", directory, "--url", api.url], {
        MONOCLE_API_KEY: "key",
      });

      assert.equal(result.code, 1);
      assert.include(result.stderr, "assets/index-a1b2.js: no debug ID");
      assert.include(result.stderr, "monocle sourcemaps inject");
      assert.lengthOf(api.batches, 0);
    } finally {
      await api.close();
    }
  });

  test("exits with code 1 without an API key", async ({ assert }) => {
    const result = await SourcemapsTest.run(["upload", directory]);

    assert.equal(result.code, 1);
    assert.include(result.stderr, "Error: Missing API key");
  });

  test("reports authentication and upload failures with code 1", async ({ assert }) => {
    await SourcemapsTest.run(["inject", directory]);

    const unauthorized = await SourcemapsTest.api((_request, response) => {
      response.writeHead(401);
      response.end();
      return true;
    });
    try {
      const result = await SourcemapsTest.run(["upload", directory, "--url", unauthorized.url], {
        MONOCLE_API_KEY: "wrong-key",
      });
      assert.equal(result.code, 1);
      assert.include(result.stderr, "Error: Authentication failed");
      assert.notInclude(result.stderr + result.stdout, "wrong-key");
    } finally {
      await unauthorized.close();
    }

    const broken = await SourcemapsTest.api((request, response) => {
      if (!request.url!.endsWith("/map")) return false;
      response.writeHead(403);
      response.end();
      return true;
    });
    try {
      const result = await SourcemapsTest.run(["upload", directory, "--url", broken.url], {
        MONOCLE_API_KEY: "key",
      });
      assert.equal(result.code, 1);
      assert.include(result.stderr, "2 source map(s) failed to upload");
      assert.include(result.stderr, "Source map upload failed (403)");
      assert.lengthOf(broken.completed, 0);
    } finally {
      await broken.close();
    }
  });
});
