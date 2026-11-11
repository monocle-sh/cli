import { processCLIArgs, configure, run } from "@japa/runner";
import { fileSystem } from "@japa/file-system";
import { assert } from "@japa/assert";

processCLIArgs(process.argv.slice(2));
configure({
  files: ["tests/**/*.spec.ts"],
  // Tests spawn the CLI; one spawn takes about 1 s on emulated amd64 self-hosted runners.
  timeout: 10_000,
  plugins: [assert(), fileSystem({ autoClean: true })],
});

void run();
