import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { confirm, isCancel, multiselect, outro } from "@clack/prompts";
import pc from "picocolors";

type AgentFileKind = "AGENTS" | "CLAUDE";

interface AgentInstallTarget {
  exists: boolean;
  filePath: string;
  kind: AgentFileKind;
}

interface InstallAgentsOptions {
  cwd?: string;
  skipConfirmation?: boolean;
  targets?: string[];
}

export class InstallAgents {
  static readonly #blockStart = "<!-- monocle-studio:start -->";
  static readonly #blockEnd = "<!-- monocle-studio:end -->";
  static readonly #managedBlock = `${InstallAgents.#blockStart}
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
${InstallAgents.#blockEnd}`;

  readonly #cwd: string;
  readonly #skipConfirmation: boolean;
  readonly #targets?: string[];

  /**
   * Capture install options once so every filesystem operation resolves from the same cwd.
   */
  constructor(options: InstallAgentsOptions = {}) {
    this.#cwd = resolve(options.cwd ?? process.cwd());
    this.#skipConfirmation = options.skipConfirmation ?? false;
    this.#targets = options.targets?.map((target) => resolve(this.#cwd, target));
  }

  /**
   * Install or refresh the managed Monocle Studio block in the chosen agent file(s).
   */
  async execute() {
    const targets = await this.#resolveTargets();
    if (!targets) return;

    const results = await Promise.all(targets.map((target) => this.#installFile(target.filePath)));
    outro(this.#renderSummary(results));
  }

  /**
   * Resolve the file(s) that should receive the managed block and confirm the write when interactive.
   */
  async #resolveTargets() {
    const targets = this.#targets
      ? await this.#resolveExplicitTargets()
      : await this.#pickTargets();
    if (!targets) return this.#abort();

    const confirmed = this.#skipConfirmation ? true : await this.#confirmTargets(targets);
    if (!confirmed) return this.#abort();

    return targets;
  }

  /**
   * Resolve explicit target paths into writable install targets.
   */
  async #resolveExplicitTargets() {
    return Promise.all(
      this.#targets!.map(async (filePath) => ({
        exists: await this.#fileExists(filePath),
        filePath,
        kind: filePath.endsWith("CLAUDE.md") ? ("CLAUDE" as const) : ("AGENTS" as const),
      })),
    );
  }

  /**
   * Pick install targets automatically or ask the user when multiple files are available.
   */
  async #pickTargets() {
    const targets = await this.#detectTargets();
    if (targets.length === 1) return [targets[0]];

    return this.#promptForTargets(targets);
  }

  /**
   * Discover candidate agent files and collapse AGENTS/CLAUDE symlink pairs into one target.
   */
  async #detectTargets(): Promise<AgentInstallTarget[]> {
    const agentsPath = resolve(this.#cwd, "AGENTS.md");
    const claudePath = resolve(this.#cwd, "CLAUDE.md");

    const [agentsExists, claudeExists] = await Promise.all([
      this.#fileExists(agentsPath),
      this.#fileExists(claudePath),
    ]);

    if (!agentsExists && !claudeExists) {
      return [{ exists: false, filePath: agentsPath, kind: "AGENTS" }];
    }

    if (agentsExists && claudeExists) {
      const [agentsRealpath, claudeRealpath] = await Promise.all([
        this.#resolveRealpath(agentsPath),
        this.#resolveRealpath(claudePath),
      ]);

      if (agentsRealpath === claudeRealpath) {
        return [{ exists: true, filePath: agentsPath, kind: "AGENTS" }];
      }

      return [
        { exists: true, filePath: agentsPath, kind: "AGENTS" },
        { exists: true, filePath: claudePath, kind: "CLAUDE" },
      ];
    }

    if (agentsExists) return [{ exists: true, filePath: agentsPath, kind: "AGENTS" }];

    return [{ exists: true, filePath: claudePath, kind: "CLAUDE" }];
  }

  /**
   * Let the user choose one or more agent files that should receive the managed block.
   */
  async #promptForTargets(targets: AgentInstallTarget[]) {
    const answer = await multiselect({
      message: "Where should Monocle Studio agent instructions be installed?",
      withGuide: false,
      initialValues: [targets[0].filePath],
      options: targets.map((target) => ({
        value: target.filePath,
        label: `${target.kind}.md`,
        hint: target.exists ? "existing file" : "will be created",
      })),
    });

    if (isCancel(answer)) return null;

    return targets.filter((target) => answer.includes(target.filePath));
  }

  /**
   * Confirm that the selected file(s) may be modified.
   */
  async #confirmTargets(targets: AgentInstallTarget[]) {
    const answer = await confirm({
      message: `Install Monocle Studio agent instructions in ${this.#humanizeTargets(targets)}?`,
      initialValue: true,
      withGuide: false,
    });

    if (isCancel(answer)) return false;

    return answer;
  }

  /**
   * Render the final CLI summary after all selected files have been processed.
   */
  #renderSummary(results: { filePath: string; status: "created" | "updated" | "unchanged" }[]) {
    const lines = results.map((result) => {
      const relativePath = this.#relativePath(result.filePath);
      if (result.status === "unchanged") {
        return pc.dim(`Monocle Studio instructions already installed in ${relativePath}`);
      }

      return pc.green(`Monocle Studio instructions ${result.status} in ${relativePath}`);
    });

    return lines.join("\n");
  }

  /**
   * Format selected target paths into a short human-readable list for confirmations.
   */
  #humanizeTargets(targets: AgentInstallTarget[]) {
    const labels = targets.map((target) => this.#relativePath(target.filePath));
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;

    return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
  }

  /**
   * Write the managed block to disk while preserving everything outside that block.
   */
  async #installFile(filePath: string) {
    const parentDir = dirname(filePath);
    if (!(await this.#fileExists(parentDir))) {
      throw new Error(`Directory does not exist: ${parentDir}`);
    }

    const exists = await this.#fileExists(filePath);
    const currentContent = exists ? await readFile(filePath, "utf8") : "";
    const nextContent = this.#upsertManagedBlock(currentContent);

    if (nextContent === currentContent) {
      return { filePath, status: "unchanged" as const };
    }

    await writeFile(filePath, nextContent, "utf8");

    return {
      filePath,
      status: exists ? ("updated" as const) : ("created" as const),
    };
  }

  /**
   * Insert the managed block at the end of the file or replace the existing managed block in place.
   */
  #upsertManagedBlock(content: string) {
    const startIndex = content.indexOf(InstallAgents.#blockStart);
    const endIndex = content.indexOf(InstallAgents.#blockEnd);

    if (startIndex === -1 && endIndex === -1) {
      return this.#appendManagedBlock(content, InstallAgents.#managedBlock);
    }

    if (startIndex === -1 || endIndex === -1) {
      throw new Error("Found a malformed Monocle Studio managed block. Please fix it manually.");
    }

    const secondStartIndex = content.indexOf(
      InstallAgents.#blockStart,
      startIndex + InstallAgents.#blockStart.length,
    );
    const secondEndIndex = content.indexOf(
      InstallAgents.#blockEnd,
      endIndex + InstallAgents.#blockEnd.length,
    );

    if (secondStartIndex !== -1 || secondEndIndex !== -1) {
      throw new Error("Found multiple Monocle Studio managed blocks. Please fix them manually.");
    }

    if (endIndex < startIndex) {
      throw new Error("Found a malformed Monocle Studio managed block. Please fix it manually.");
    }

    const blockEndIndex = endIndex + InstallAgents.#blockEnd.length;
    return `${content.slice(0, startIndex)}${InstallAgents.#managedBlock}${content.slice(blockEndIndex)}`;
  }

  /**
   * Append the managed block with stable spacing so repeated installs stay idempotent.
   */
  #appendManagedBlock(content: string, block: string) {
    if (!content.length) return `${block}\n`;
    if (content.endsWith("\n\n")) return `${content}${block}\n`;
    if (content.endsWith("\n")) return `${content}\n${block}\n`;

    return `${content}\n\n${block}\n`;
  }

  /**
   * Convert absolute paths back to cwd-relative paths for human-friendly prompts and output.
   */
  #relativePath(filePath: string) {
    return filePath.startsWith(this.#cwd) ? filePath.slice(this.#cwd.length + 1) : filePath;
  }

  /**
   * Centralize interactive abort handling so every cancelled path exits consistently.
   */
  #abort() {
    outro(pc.dim("Aborted."));
    return null;
  }

  /**
   * Check file existence without throwing when the path is missing.
   */
  async #fileExists(filePath: string) {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve symlinks when possible so AGENTS.md and CLAUDE.md aliases can be deduplicated.
   */
  async #resolveRealpath(filePath: string) {
    try {
      return await realpath(filePath);
    } catch {
      return filePath;
    }
  }
}

/**
 * Convenience wrapper used by the Commander action.
 */
export async function installAgents(options: InstallAgentsOptions = {}) {
  await new InstallAgents(options).execute();
}
