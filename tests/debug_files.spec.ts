import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "@japa/runner";

const SOURCE = `#include <stdio.h>\n\nint main(void) {\n  puts("orders");\n  return 0;\n}\n`;

class DebugFilesTest {
  static async run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("@poppinss/ts-exec"),
        resolve(import.meta.dirname, "../src/cli.ts"),
        "debug-files",
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
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const code = await new Promise<number | null>((done, reject) => {
      child.on("error", reject);
      child.on("close", done);
    });

    return { code, stdout, stderr };
  }

  /**
   * A C build with DWARF and a GNU build ID, as Rust produces with `debug = 1`.
   */
  static build() {
    const directory = mkdtempSync(join(tmpdir(), "monocle-cli-debug-files-"));
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src/app.c"), SOURCE);
    execFileSync("cc", ["-g", "-O0", "-Wl,--build-id", "-o", "app", "src/app.c"], {
      cwd: directory,
    });
    const notes = execFileSync("readelf", ["--notes", join(directory, "app")], {
      encoding: "utf8",
    });
    const buildId = /Build ID: ([\da-f]+)/.exec(notes)![1];

    return { directory, binary: join(directory, "app"), buildId };
  }

  static async api(status: (request: IncomingMessage) => number = () => 200) {
    const requests: Array<{ url: string; key?: string; body: Buffer }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      requests.push({ url: request.url!, key: request.headers["x-api-key"] as string, body });
      const code = status(request);
      if (code !== 200) {
        response.writeHead(code, { "content-type": "application/json" });
        return response.end(JSON.stringify({ errors: [{ message: "nope" }] }));
      }

      const json = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url === "/native-symbols/uploads") {
        const { files } = JSON.parse(body.toString());
        return json({
          data: {
            files: [
              {
                status: "upload",
                uploadUrl: `${url}/put/${files[0].kind}`,
                attemptId: `attempt-${files[0].kind}`,
              },
            ],
          },
        });
      }
      if (request.url === "/native-symbols/uploads/complete")
        return json({ data: { status: "ready" } });
      response.writeHead(200);
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port");
    const url = `http://127.0.0.1:${address.port}`;

    return {
      url,
      requests,
      close: () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    };
  }
}

test.group("debug-files upload", (group) => {
  let build: ReturnType<typeof DebugFilesTest.build>;

  group.each.setup(() => {
    build = DebugFilesTest.build();
    return () => rmSync(build.directory, { recursive: true, force: true });
  });

  test("uploads the debug file and a source bundle keyed by the GNU build ID", async ({
    assert,
  }) => {
    const api = await DebugFilesTest.api();
    try {
      const result = await DebugFilesTest.run(
        ["upload", build.binary, "--include-sources", "--root", build.directory, "--url", api.url],
        { MONOCLE_API_KEY: "deploy-token" },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.include(result.stdout, "Sources: 1 file(s)");

      const prepares = api.requests.filter((r) => r.url === "/native-symbols/uploads");
      assert.deepEqual(
        prepares.map((r) => JSON.parse(r.body.toString()).files[0]),
        [
          {
            codeId: build.buildId,
            kind: "debug",
            filePath: "app",
            size: readFileSync(build.binary).length,
          },
          {
            codeId: build.buildId,
            kind: "sources",
            filePath: "app.sources.zip",
            size: api.requests.find((r) => r.url === "/put/sources")!.body.length,
          },
        ],
      );
      assert.isTrue(
        api.requests.every((r) => r.url.startsWith("/put/") || r.key === "deploy-token"),
      );
      assert.deepEqual(
        api.requests.find((r) => r.url === "/put/debug")!.body,
        readFileSync(build.binary),
      );
      assert.deepEqual(
        api.requests
          .filter((r) => r.url === "/native-symbols/uploads/complete")
          .map((r) => JSON.parse(r.body.toString())),
        [
          { codeId: build.buildId, kind: "debug", attemptId: "attempt-debug" },
          { codeId: build.buildId, kind: "sources", attemptId: "attempt-sources" },
        ],
      );

      // A symbolic source bundle: an SYSB header, then a ZIP with a manifest and the files.
      const bundle = api.requests.find((r) => r.url === "/put/sources")!.body;
      assert.equal(bundle.subarray(0, 4).toString(), "SYSB");
      const zip = join(build.directory, "bundle.zip");
      writeFileSync(zip, bundle);
      const manifest = JSON.parse(
        execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }),
      );
      assert.equal(manifest.code_id, build.buildId);
      const [entry, info] = Object.entries<{ path: string }>(manifest.files)[0];
      assert.equal(info.path, join(build.directory, "src/app.c"));
      assert.equal(execFileSync("unzip", ["-p", zip, entry], { encoding: "utf8" }), SOURCE);
    } finally {
      await api.close();
    }
  });

  test("rejects a stripped binary without contacting Monocle", async ({ assert }) => {
    const api = await DebugFilesTest.api();
    try {
      const stripped = join(build.directory, "stripped");
      copyFileSync(build.binary, stripped);
      execFileSync("strip", [stripped]);
      const result = await DebugFilesTest.run(["upload", stripped, "--url", api.url], {
        MONOCLE_API_KEY: "deploy-token",
      });

      assert.equal(result.code, 1);
      assert.include(result.stderr, "has no DWARF debug information");
      assert.lengthOf(api.requests, 0);
    } finally {
      await api.close();
    }
  });

  test("uploads nothing when no source matches the build directory", async ({ assert }) => {
    const api = await DebugFilesTest.api();
    try {
      const result = await DebugFilesTest.run(
        [
          "upload",
          build.binary,
          "--include-sources",
          "--root",
          build.directory,
          "--prefix",
          "/app",
        ],
        { MONOCLE_API_KEY: "deploy-token" },
      );

      assert.equal(result.code, 1);
      assert.include(result.stderr, "No source files of");
      assert.lengthOf(api.requests, 0);
    } finally {
      await api.close();
    }
  });

  test("explains a rejected token", async ({ assert }) => {
    const api = await DebugFilesTest.api(() => 401);
    try {
      const result = await DebugFilesTest.run(["upload", build.binary, "--url", api.url], {
        MONOCLE_API_KEY: "ingest-dsn-key",
      });

      assert.equal(result.code, 1);
      assert.include(result.stderr, "Use a project token with the Deploy scope");
    } finally {
      await api.close();
    }
  });
});

test.group("debug-files check", (group) => {
  let build: ReturnType<typeof DebugFilesTest.build>;

  group.each.setup(() => {
    build = DebugFilesTest.build();
    return () => rmSync(build.directory, { recursive: true, force: true });
  });

  test("finds the sources of a build with relative DWARF paths", async ({ assert }) => {
    // Path remapping, as with --remap-path-prefix in Rust, records paths relative to the build.
    execFileSync(
      "cc",
      [
        "-g",
        "-O0",
        "-Wl,--build-id",
        `-fdebug-prefix-map=${build.directory}=.`,
        "-o",
        "relative",
        "src/app.c",
      ],
      { cwd: build.directory },
    );
    const result = await DebugFilesTest.run([
      "check",
      join(build.directory, "relative"),
      "--include-sources",
      "--root",
      build.directory,
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.include(result.stdout, "Sources: 1 file(s)");
    assert.include(result.stdout, "    src/app.c\n");
  });
});
