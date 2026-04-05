import * as nodeFs from "node:fs";
import * as path from "node:path";

import { test } from "@japa/runner";

import { InstallAgents } from "../src/studio/install_agents.js";

const managedBlock = `<!-- monocle-studio:start -->
## Monocle Studio

Monocle Studio exposes two local interfaces:

- CLI: \`monocle studio ...\`
- MCP: \`http://localhost:4200/mcp\`

Both read local Studio data, not hosted Monocle data.

### MCP

- \`list_errors(limit?, offset?, traceId?)\`
- \`list_traces(limit?, offset?, traceId?)\`
- \`get_trace(traceId)\`
- \`list_logs(limit?, offset?, severity?, search?, traceId?)\`
- \`list_queries(limit?, offset?, traceId?, dbSystem?)\`

Treat \`clear_data\` as destructive. Do not call it unless the user explicitly asks for a reset.

### CLI

Shared flags: \`--port 4200\`, \`--format pretty|json|short\`. Use \`json\` for machine-readable output.

- \`traces\`: \`--limit 25\`, \`--service\`, \`--trace-id\`
- \`logs\`: \`--limit 50\`, \`--severity\`, \`--search\`, \`--trace-id\`
- \`errors\`: \`--limit 25\`, \`--trace-id\`
<!-- monocle-studio:end -->`;

test.group("install-agents", () => {
  test("creates AGENTS.md by default when no file exists", async ({ assert, fs }) => {
    await fs.mkdir(".");

    await new InstallAgents({
      cwd: fs.basePath,
      skipConfirmation: true,
      targets: ["AGENTS.md"],
    }).execute();

    const content = await fs.contents("AGENTS.md");

    assert.include(content, managedBlock);
  });

  test("writes to AGENTS.md when CLAUDE.md is a symlink to it", async ({ assert, fs }) => {
    const claudePath = path.join(fs.basePath, "CLAUDE.md");

    await fs.create("AGENTS.md", "# Repo instructions\n");
    nodeFs.symlinkSync("AGENTS.md", claudePath);

    await new InstallAgents({
      cwd: fs.basePath,
      skipConfirmation: true,
      targets: ["AGENTS.md"],
    }).execute();

    const content = await fs.contents("AGENTS.md");

    assert.include(content, "# Repo instructions\n");
    assert.equal(content.match(/monocle-studio:start/g)?.length, 1);
  });

  test("appends the managed block without removing existing content", async ({ assert, fs }) => {
    await fs.create("AGENTS.md", "# Repo instructions\n");

    await new InstallAgents({
      cwd: fs.basePath,
      skipConfirmation: true,
      targets: ["AGENTS.md"],
    }).execute();

    const content = await fs.contents("AGENTS.md");

    assert.include(content, "# Repo instructions\n");
    assert.include(content, managedBlock);
    assert.equal(content.match(/monocle-studio:start/g)?.length, 1);
  });

  test("replaces an existing managed block in place", async ({ assert, fs }) => {
    const previousBlock = managedBlock.replace("Use \\`json\\`", "Use \\`pretty\\`");
    await fs.create("AGENTS.md", `# Repo instructions\n\n${previousBlock}\n\n## Tail\n`);

    await new InstallAgents({
      cwd: fs.basePath,
      skipConfirmation: true,
      targets: ["AGENTS.md"],
    }).execute();

    const content = await fs.contents("AGENTS.md");

    assert.equal(content.match(/monocle-studio:start/g)?.length, 1);
    assert.notInclude(content, "Use \\`pretty\\`");
    assert.include(content, "## Tail\n");
    assert.include(content, managedBlock);
  });

  test("throws when the managed block is malformed", async ({ assert, fs }) => {
    await fs.create("AGENTS.md", "# Repo instructions\n\n<!-- monocle-studio:start -->\n");

    await assert.rejects(
      () =>
        new InstallAgents({
          cwd: fs.basePath,
          skipConfirmation: true,
          targets: ["AGENTS.md"],
        }).execute(),
      /malformed Monocle Studio managed block/,
    );
  });

  test("does not rewrite the file when the block is already current", async ({ assert, fs }) => {
    await fs.create("AGENTS.md", `${managedBlock}\n`);

    const before = await fs.contents("AGENTS.md");
    await new InstallAgents({
      cwd: fs.basePath,
      skipConfirmation: true,
      targets: ["AGENTS.md"],
    }).execute();
    const after = await fs.contents("AGENTS.md");

    assert.equal(after, before);
  });
});
