import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  clean: true,
  dts: true,
  deps: {
    alwaysBundle: [/^@monocle\.sh\/otel-utils(?:\/|$)/],
    neverBundle: ["@monocle.sh/studio"],
  },
});
