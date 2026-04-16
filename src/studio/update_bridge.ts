import type { UpdateBridge, UpdateState } from "@monocle.sh/studio";

const SIX_HOURS = 6 * 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/@monocle.sh/cli/latest";

type StateListener = (state: UpdateState) => void;

interface CliBridgeOptions {
  currentVersion: string;
  pollIntervalMs?: number;
  registryUrl?: string;
}

/**
 * Parses a semver-ish string into a tuple for lexicographic comparison.
 * Returns null for invalid input so callers can short-circuit.
 */
function parseVersion(value: string): number[] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;

  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }

  return false;
}

/**
 * Polls the npm registry for the latest `@monocle.sh/cli` version and
 * exposes the result through the shared UpdateBridge contract.
 * The CLI runtime cannot auto-install — it surfaces a copy-pasteable
 * install command instead.
 */
export function createCliUpdateBridge(options: CliBridgeOptions): UpdateBridge {
  const listeners = new Set<StateListener>();
  const pollInterval = options.pollIntervalMs ?? SIX_HOURS;
  const registryUrl = options.registryUrl ?? REGISTRY_URL;

  let state: UpdateState = {
    runtime: "cli",
    currentVersion: options.currentVersion,
    status: "idle",
    latest: null,
    progress: null,
    error: null,
    canAutoInstall: false,
  };

  const update = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };

  const check = async () => {
    update({ status: "checking", error: null });

    try {
      const res = await fetch(registryUrl, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Registry returned ${res.status}`);

      const data: any = await res.json();
      const latest = typeof data?.version === "string" ? data.version : null;
      if (!latest) throw new Error("Registry response missing version");

      if (!isNewer(latest, options.currentVersion)) {
        update({ status: "idle", latest: null });
        return;
      }

      update({
        status: "available",
        latest: {
          version: latest,
          installCommand: "npm i -g @monocle.sh/cli@latest",
          releaseUrl: `https://www.npmjs.com/package/@monocle.sh/cli/v/${latest}`,
        },
      });
    } catch (err: any) {
      update({ status: "error", error: err?.message ?? "Unknown error" });
    }
  };

  check();
  const timer = setInterval(check, pollInterval);
  timer.unref?.();

  return {
    get state() {
      return state;
    },
    checkForUpdates: check,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
