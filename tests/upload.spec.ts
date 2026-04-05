import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { test } from "@japa/runner";

import {
  findSourcemapFiles,
  loadAndValidateSourcemap,
  validateSourcemap,
  UploadError,
} from "../src/upload.js";

test.group("findSourcemapFiles", (group) => {
  let tmpDir: string;

  group.each.setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monocle-cli-test-"));
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
  });

  group.each.teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds .map files matching glob patterns", async ({ assert }) => {
    fs.writeFileSync(path.join(tmpDir, "dist", "index.js.map"), "{}");
    fs.writeFileSync(path.join(tmpDir, "dist", "vendor.js.map"), "{}");
    fs.writeFileSync(path.join(tmpDir, "dist", "index.js"), 'console.log("hi")');

    const files = await findSourcemapFiles([path.join(tmpDir, "dist", "**", "*")]);

    assert.equal(files.length, 2);
    assert.isTrue(files.every((f) => f.endsWith(".map")));
  });

  test("returns empty array when no files match", async ({ assert }) => {
    const files = await findSourcemapFiles([path.join(tmpDir, "nonexistent", "**", "*.map")]);

    assert.equal(files.length, 0);
  });

  test("ignores node_modules", async ({ assert }) => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", "lib.js.map"), "{}");
    fs.writeFileSync(path.join(tmpDir, "dist", "index.js.map"), "{}");

    const files = await findSourcemapFiles([path.join(tmpDir, "**", "*.map")]);

    assert.equal(files.length, 1);
    assert.isTrue(files[0].includes("dist"));
  });
});

test.group("loadAndValidateSourcemap", (group) => {
  let tmpDir: string;

  group.each.setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monocle-cli-test-"));
  });

  group.each.teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads and validates a correct source map", ({ assert }) => {
    const validMap = {
      version: 3,
      sources: ["src/index.ts"],
      names: [],
      mappings: "AAAA",
    };
    const filePath = path.join(tmpDir, "valid.js.map");
    fs.writeFileSync(filePath, JSON.stringify(validMap));

    const result = loadAndValidateSourcemap(filePath);

    assert.equal(result.filename, "valid.js.map");
    assert.equal(result.path, filePath);
    assert.isTrue(result.content instanceof Buffer);
    assert.isAbove(result.size, 0);
  });

  test("throws UploadError for invalid JSON", ({ assert }) => {
    const filePath = path.join(tmpDir, "invalid.js.map");
    fs.writeFileSync(filePath, "not json");

    assert.throws(() => loadAndValidateSourcemap(filePath), UploadError, /invalid JSON/);
  });

  test("throws UploadError for source map without version", ({ assert }) => {
    const invalidMap = { sources: ["src/index.ts"], mappings: "AAAA" };
    const filePath = path.join(tmpDir, "no-version.js.map");
    fs.writeFileSync(filePath, JSON.stringify(invalidMap));

    assert.throws(() => loadAndValidateSourcemap(filePath), UploadError, /missing version field/);
  });

  test("throws UploadError for source map without sources array", ({ assert }) => {
    const invalidMap = { version: 3, mappings: "AAAA" };
    const filePath = path.join(tmpDir, "no-sources.js.map");
    fs.writeFileSync(filePath, JSON.stringify(invalidMap));

    assert.throws(() => loadAndValidateSourcemap(filePath), UploadError, /missing sources array/);
  });

  test("throws UploadError for source map without mappings", ({ assert }) => {
    const invalidMap = { version: 3, sources: ["src/index.ts"] };
    const filePath = path.join(tmpDir, "no-mappings.js.map");
    fs.writeFileSync(filePath, JSON.stringify(invalidMap));

    assert.throws(() => loadAndValidateSourcemap(filePath), UploadError, /missing mappings field/);
  });

  test("throws UploadError for file exceeding 50MB", ({ assert }) => {
    const filePath = path.join(tmpDir, "large.js.map");
    const fd = fs.openSync(filePath, "w");
    fs.writeSync(fd, "{}", 51 * 1024 * 1024);
    fs.closeSync(fd);

    assert.throws(() => loadAndValidateSourcemap(filePath), UploadError, /exceeds 50MB limit/);
  });
});

test.group("validateSourcemap (legacy)", (group) => {
  let tmpDir: string;

  group.each.setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monocle-cli-test-"));
  });

  group.each.teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns valid: true for correct source map", ({ assert }) => {
    const validMap = {
      version: 3,
      sources: ["src/index.ts"],
      names: [],
      mappings: "AAAA",
    };
    const filePath = path.join(tmpDir, "valid.js.map");
    fs.writeFileSync(filePath, JSON.stringify(validMap));

    const result = validateSourcemap(filePath);

    assert.isTrue(result.valid);
    assert.isUndefined(result.error);
  });

  test("returns valid: false with error for invalid source map", ({ assert }) => {
    const filePath = path.join(tmpDir, "invalid.js.map");
    fs.writeFileSync(filePath, "not json");

    const result = validateSourcemap(filePath);

    assert.isFalse(result.valid);
    assert.isTrue(result.error?.includes("invalid JSON"));
  });
});

test.group("UploadError", () => {
  test("creates error with correct name", ({ assert }) => {
    const error = new UploadError("test message");

    assert.equal(error.name, "UploadError");
    assert.equal(error.message, "test message");
    assert.isTrue(error instanceof Error);
  });
});
