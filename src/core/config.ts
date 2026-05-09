/**
 * core/config.ts
 *
 * Loads, validates, and provides typed access to duostack.config.json.
 *
 * Key design decisions:
 * - Config is loaded once at startup and cached. No hot-reload —
 *   changing config requires a restart. This keeps state predictable.
 * - All values have sensible defaults so minimal config is needed.
 * - Config is read-only after load. No runtime mutation.
 * - The config file lives in .duostack/duostack.config.json inside
 *   the project repo — travels with the project, not with the tool.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PORT } from "../api/server.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DuostackConfig {
  version: string;
  stacklitVersion: string;
  projectPath: string;
  stateDir: string;

  api: {
    port: number;
    host: string;
  };

  leases: {
    durationMinutes: number;
    renewalThresholdMinutes: number;
    maxAttempts: number;
  };

  agents: {
    claude: AgentConfig;
    antigravity: AgentConfig;
  };

  orchestrator: {
    pollIntervalMs: number;
    debounceMs: number;
    fileWatchEnabled: boolean;
  };

  stacklit: {
    jsonPath: string;       // path to stacklit.json
    enabled: boolean;
    fullIndexTokenBudget: number;   // tokens — skip full read above this
    deriveMapTokenBudget: number;   // tokens — skip derive above this
  };

  efficiency: {
    trackingEnabled: boolean;
    logPath: string;
  };

  checkpoints: {
    afterEachDecision: boolean;
    afterTaskBatch: boolean;
    intervalOperations: number;   // checkpoint every N operations
  };
}

export interface AgentConfig {
  role: "planner" | "executor";
  fallbackRole: "executor" | "tactical-planner";
  leaseExtensionEnabled: boolean;
  backoffSteps: Record<number, number>; // failureCount → backoffMs
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export function defaultConfig(projectPath: string): DuostackConfig {
  const stateDir = path.join(projectPath, ".duostack", "state");

  return {
    version: "0.1.0",
    stacklitVersion: "0.3.0",
    projectPath,
    stateDir,

    api: {
      port: DEFAULT_PORT,
      host: "127.0.0.1",
    },

    leases: {
      durationMinutes: 20,
      renewalThresholdMinutes: 5,
      maxAttempts: 5,
    },

    agents: {
      claude: {
        role: "planner",
        fallbackRole: "executor",
        leaseExtensionEnabled: true,
        backoffSteps: {
          3:  5  * 60 * 1000,
          10: 60 * 60 * 1000,
          50: 6  * 60 * 60 * 1000,
        },
      },
      antigravity: {
        role: "executor",
        fallbackRole: "tactical-planner",
        leaseExtensionEnabled: true,
        backoffSteps: {
          3:  5  * 60 * 1000,
          10: 60 * 60 * 1000,
          50: 6  * 60 * 60 * 1000,
        },
      },
    },

    orchestrator: {
      pollIntervalMs: 30_000,
      debounceMs: 500,
      fileWatchEnabled: true,
    },

    stacklit: {
      jsonPath: path.join(projectPath, "stacklit.json"),
      enabled: true,
      fullIndexTokenBudget: 4_000,
      deriveMapTokenBudget: 250,
    },

    efficiency: {
      trackingEnabled: true,
      logPath: path.join(projectPath, ".duostack", "efficiency.json"),
    },

    checkpoints: {
      afterEachDecision: true,
      afterTaskBatch: true,
      intervalOperations: 10,
    },
  };
}

// ─── Config loader ────────────────────────────────────────────────────────────

export class ConfigLoader {
  private configPath: string;
  private config: DuostackConfig | null = null;

  constructor(projectPath: string) {
    this.configPath = path.join(
      projectPath,
      ".duostack",
      "duostack.config.json"
    );
  }

  /**
   * Load config from disk, merging with defaults.
   * Missing fields fall back to defaults — partial config is valid.
   */
  async load(): Promise<DuostackConfig> {
    if (this.config) return this.config;

    const defaults = defaultConfig(
      path.dirname(path.dirname(this.configPath))
    );

    if (!fs.existsSync(this.configPath)) {
      console.warn(
        `[config] duostack.config.json not found at ${this.configPath} — using defaults`
      );
      this.config = defaults;
      return defaults;
    }

    try {
      const raw = await fsPromises.readFile(this.configPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DuostackConfig>;
      this.config = this.merge(defaults, parsed);
      return this.config;
    } catch (err) {
      console.error(`[config] failed to parse config: ${err}`);
      console.warn("[config] falling back to defaults");
      this.config = defaults;
      return defaults;
    }
  }

  /**
   * Synchronous load — for use in CLI before async context is available.
   * Returns defaults if file doesn't exist or can't be parsed.
   */
  loadSync(): DuostackConfig {
    const defaults = defaultConfig(
      path.dirname(path.dirname(this.configPath))
    );

    if (!fs.existsSync(this.configPath)) return defaults;

    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DuostackConfig>;
      return this.merge(defaults, parsed);
    } catch {
      return defaults;
    }
  }

  /**
   * Write config to disk.
   * Called by `duostack init` to save the generated config.
   */
  async write(config: DuostackConfig): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(
      this.configPath,
      JSON.stringify(config, null, 2),
      "utf-8"
    );
    this.config = config;
  }

  // Deep merge — file values override defaults, missing values use defaults
  private merge(
    defaults: DuostackConfig,
    overrides: Partial<DuostackConfig>
  ): DuostackConfig {
    return {
      ...defaults,
      ...overrides,
      api: { ...defaults.api, ...(overrides.api ?? {}) },
      leases: { ...defaults.leases, ...(overrides.leases ?? {}) },
      agents: {
        claude: {
          ...defaults.agents.claude,
          ...(overrides.agents?.claude ?? {}),
        },
        antigravity: {
          ...defaults.agents.antigravity,
          ...(overrides.agents?.antigravity ?? {}),
        },
      },
      orchestrator: {
        ...defaults.orchestrator,
        ...(overrides.orchestrator ?? {}),
      },
      stacklit: { ...defaults.stacklit, ...(overrides.stacklit ?? {}) },
      efficiency: { ...defaults.efficiency, ...(overrides.efficiency ?? {}) },
      checkpoints: {
        ...defaults.checkpoints,
        ...(overrides.checkpoints ?? {}),
      },
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createConfigLoader(projectPath: string): ConfigLoader {
  return new ConfigLoader(projectPath);
}

/**
 * Quick helper — load config for a project path.
 * Used throughout the codebase for one-shot config reads.
 */
export async function loadConfig(projectPath: string): Promise<DuostackConfig> {
  return new ConfigLoader(projectPath).load();
}
