import * as path from "node:path";
import * as fs from "node:fs";

import pc from "picocolors";
import { Spinner } from "picospinner";
import ky, { HTTPError, TimeoutError } from "ky";
import { glob } from "tinyglobby";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const UPLOAD_TIMEOUT = 120_000; // 2 minutes

export interface UploadSourcemapsOptions {
  patterns: string[];
  apiKey: string;
  release: string;
  apiUrl: string;
  dryRun?: boolean;
}

export interface UploadResult {
  uploaded: Array<{ filename: string; release: string; sizeBytes: number }>;
  count: number;
}

export interface SourcemapFile {
  path: string;
  filename: string;
  content: Buffer;
  size: number;
}

/**
 * Upload source maps to Monocle API.
 */
export async function uploadSourcemaps(options: UploadSourcemapsOptions): Promise<UploadResult> {
  const { patterns, apiKey, release, apiUrl, dryRun } = options;

  const spinner = new Spinner("Finding source map files...");
  spinner.start();

  const filePaths = await findSourcemapFiles(patterns);

  if (filePaths.length === 0) {
    spinner.fail("No source map files found");
    console.error(pc.yellow(`Searched patterns: ${patterns.join(", ")}`));
    console.error(pc.dim("Make sure the glob patterns match .map files in your build output"));
    throw new UploadError("No source map files found");
  }

  spinner.setText(`Validating ${filePaths.length} source map file(s)...`);

  const files: SourcemapFile[] = [];
  for (const filePath of filePaths) {
    const file = loadAndValidateSourcemap(filePath);
    files.push(file);
  }

  spinner.succeed(`Found ${files.length} valid source map file(s)`);

  for (const file of files) {
    const sizeKb = (file.size / 1024).toFixed(1);
    console.log(pc.dim(`  ${file.path} (${sizeKb} KB)`));
  }

  if (dryRun) {
    console.log(pc.yellow("\nDry run mode - no files uploaded"));
    return { uploaded: [], count: 0 };
  }

  spinner.setText(`Uploading to ${sanitizeUrl(apiUrl)}...`);
  spinner.start();

  const result = await uploadFiles({
    files,
    apiKey,
    release,
    apiUrl,
    onProgress: (current, total) => {
      spinner.setText(`Uploading file ${current}/${total} to ${sanitizeUrl(apiUrl)}...`);
    },
  });

  spinner.succeed(`Uploaded ${result.count} source map(s) for release ${pc.cyan(release)}`);

  return result;
}

/**
 * Find source map files matching the given glob patterns.
 */
export async function findSourcemapFiles(patterns: string[]): Promise<string[]> {
  const files = await glob(patterns, {
    onlyFiles: true,
    absolute: true,
    expandDirectories: false,
  });

  return files.filter((file) => file.endsWith(".map") && !file.includes("/node_modules/"));
}

/**
 * Load and validate a source map file. Returns the file with its content.
 */
export function loadAndValidateSourcemap(filePath: string): SourcemapFile {
  const stats = fs.statSync(filePath);

  if (stats.size > MAX_FILE_SIZE) {
    const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
    throw new UploadError(`File ${filePath} exceeds 50MB limit (${sizeMb}MB)`);
  }

  const content = fs.readFileSync(filePath);
  const filename = path.basename(filePath);

  try {
    const parsed = JSON.parse(content.toString("utf-8"));

    if (typeof parsed.version !== "number") {
      throw new UploadError(`Invalid source map ${filePath}: missing version field`);
    }
    if (!Array.isArray(parsed.sources)) {
      throw new UploadError(`Invalid source map ${filePath}: missing sources array`);
    }
    if (typeof parsed.mappings !== "string") {
      throw new UploadError(`Invalid source map ${filePath}: missing mappings field`);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new UploadError(`Invalid source map ${filePath}: invalid JSON`);
    }
    throw error;
  }

  return { path: filePath, filename, content, size: stats.size };
}

/**
 * Validate that a file is a valid source map. (Legacy function for tests)
 */
export function validateSourcemap(filePath: string): { valid: boolean; error?: string } {
  try {
    loadAndValidateSourcemap(filePath);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

interface UploadFilesOptions {
  files: SourcemapFile[];
  apiKey: string;
  release: string;
  apiUrl: string;
  onProgress?: (current: number, total: number) => void;
}

/**
 * Upload files to the Monocle API.
 */
async function uploadFiles(options: UploadFilesOptions): Promise<UploadResult> {
  const { files, apiKey, release, apiUrl, onProgress } = options;

  const formData = new FormData();
  formData.append("release", release);

  let current = 0;
  for (const file of files) {
    current++;
    onProgress?.(current, files.length);

    const blob = new Blob([new Uint8Array(file.content)], { type: "application/json" });
    formData.append("files", blob, file.filename);
  }

  try {
    const response = await ky.post(`${apiUrl}/sourcemaps`, {
      headers: { "x-api-key": apiKey },
      body: formData,
      timeout: UPLOAD_TIMEOUT,
    });

    const json = (await response.json()) as { data: UploadResult };
    return json.data;
  } catch (error) {
    throw handleUploadError(error);
  }
}

/**
 * Custom error class for upload errors. Does not expose sensitive data.
 */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Handle upload errors and return a sanitized error.
 */
function handleUploadError(error: unknown): UploadError {
  if (error instanceof TimeoutError) {
    return new UploadError("Upload timed out. Check your network connection and try again.");
  }

  if (error instanceof HTTPError) {
    const status = error.response.status;

    if (status === 401) return new UploadError("Authentication failed. Check your API key.");
    if (status === 413)
      return new UploadError("Upload too large. Maximum total size is 50MB per file.");
    if (status === 429) return new UploadError("Rate limited. Please wait and try again.");
    if (status >= 500) return new UploadError(`Server error (${status}). Please try again later.`);

    return new UploadError(`Upload failed with status ${status}`);
  }

  if (error instanceof Error) {
    if (error.message.includes("ECONNREFUSED")) {
      return new UploadError("Connection refused. Check the API URL and your network.");
    }
    if (error.message.includes("ENOTFOUND")) {
      return new UploadError("DNS resolution failed. Check the API URL.");
    }
    if (error.message.includes("ETIMEDOUT")) {
      return new UploadError("Connection timed out. Check your network connection.");
    }
  }

  return new UploadError("Upload failed. Check your network connection and try again.");
}

/**
 * Sanitize URL to remove sensitive parts for display.
 */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}
