import { processCLIArgs, configure, run } from "@japa/runner";
import { fileSystem } from "@japa/file-system";
import { assert } from "@japa/assert";

processCLIArgs(process.argv.slice(2));
configure({
  files: ["tests/**/*.spec.ts"],
  plugins: [assert(), fileSystem({ autoClean: true })],
});

void run();
