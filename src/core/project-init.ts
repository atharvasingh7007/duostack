/**
 * core/project-init.ts
 *
 * Handles the full project initialization sequence.
 * Called by `duostack init` and also by `duostack serve` on first start
 * when no ProjectInitialized event exists in the log.
 *
 * Key design decisions:
 * - Initialization writes a real ProjectInitialized event to events.jsonl.
 *   This is the canonical start of the project's coordination history.
 * - Preflight checks verify that Stacklit is initialized (stacklit.json
 *   exists), git is initialized, and the state directory is writable.
 * - If the project was already initialized (ProjectInitialized event exists),
 *   init is a no-op — idempotent by design.
 * - Goal and tech stack are extracted from stacklit.json if available,
 *   so the developer doesn't have to re-specify them.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createEventStore } from "./event-store.js";
import { createSnapshotBuilder } from "./snapshot-builder.js";
import type { DuostackConfig } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InitResult {
  alreadyInitialized: boolean;
  eventId: string | null;
  projectName: string;
  goal: string;
  techStack: string[];
  warnings: string[];
}

export interface PreflightResult {
  pass: boolean;
  checks: PreflightCheck[];
}

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
  fatal: boolean;
}

// ─── Stacklit JSON shape (partial) ────────────────────────────────────────────

interface StacklitJson {
  modules?: Record<string, { purpose?: string }>;
  hints?: { test_command?: string; add_feature?: string };
  framework?: string;
  languages?: string[];
  entrypoint?: string;
}

// ─── Project initializer ──────────────────────────────────────────────────────

export class ProjectInitializer {
  private config: DuostackConfig;

  constructor(config: DuostackConfig) {
    this.config = config;
  }

  // ─── Preflight ─────────────────────────────────────────────────────────────

  /**
   * Run preflight checks before init or serve.
   * Returns results for each check — non-fatal failures are warnings.
   */
  async runPreflight(): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];

    // 1. State directory writable
    checks.push(await this.checkStateDir());

    // 2. Git initialized
    checks.push(await this.checkGit());

    // 3. Stacklit present
    checks.push(await this.checkStacklit());

    // 4. Port available
    checks.push(await this.checkPort());

    // 5. Node version
    checks.push(this.checkNodeVersion());

    const pass = checks.filter((c) => c.fatal).every((c) => c.passed);
    return { pass, checks };
  }

  // ─── Initialize ────────────────────────────────────────────────────────────

  /**
   * Write the ProjectInitialized event if it doesn't exist yet.
   * Idempotent — safe to call multiple times.
   */
  async initialize(opts: {
    projectName?: string;
    goal?: string;
    techStack?: string[];
  } = {}): Promise<InitResult> {
    const warnings: string[] = [];

    // Check if already initialized
    const store = await createEventStore(this.config.stateDir);
    const existing = await store.readLatestOfType("ProjectInitialized");

    if (existing) {
      return {
        alreadyInitialized: true,
        eventId: existing.eventId,
        projectName:
          existing.payload.projectName,
        goal: existing.payload.goal,
        techStack: existing.payload.techStack,
        warnings: [],
      };
    }

    // Extract project info from stacklit.json if available
    const stacklitInfo = await this.readStacklit();

    const projectName =
      opts.projectName ??
      path.basename(this.config.projectPath);

    const goal =
      opts.goal ??
      stacklitInfo?.goal ??
      `Build ${projectName}`;

    const techStack =
      opts.techStack ??
      stacklitInfo?.techStack ??
      [];

    if (!stacklitInfo) {
      warnings.push(
        "stacklit.json not found — run 'npx stacklit@0.3.0 init --hook' for codebase navigation"
      );
    }

    // Write ProjectInitialized event
    const event = await store.appendEvent({
      eventType: "ProjectInitialized",
      actor: "developer",
      payload: {
        projectName,
        projectPath: this.config.projectPath,
        goal,
        techStack,
        stacklitVersion: this.config.stacklitVersion,
        duostackVersion: this.config.version,
      },
    });

    // Rebuild snapshots so project.snapshot.json is immediately valid
    const builder = createSnapshotBuilder(this.config.stateDir, store);
    await builder.rebuildAll();

    console.log(`[project-init] initialized: ${projectName}`);
    console.log(`[project-init] goal: ${goal}`);

    return {
      alreadyInitialized: false,
      eventId: event.eventId,
      projectName,
      goal,
      techStack,
      warnings,
    };
  }

  // ─── Stacklit reader ───────────────────────────────────────────────────────

  /**
   * Read stacklit.json and extract useful project metadata.
   * Returns null if stacklit.json doesn't exist.
   */
  async readStacklit(): Promise<{ goal: string; techStack: string[] } | null> {
    const stacklitPath = this.config.stacklit.jsonPath;

    if (!fs.existsSync(stacklitPath)) return null;

    try {
      const raw = await fsPromises.readFile(stacklitPath, "utf-8");
      const stacklit = JSON.parse(raw) as StacklitJson;

      // Extract tech stack from languages field
      const techStack: string[] = stacklit.languages ?? [];

      // Add framework if detected
      if (stacklit.framework && !techStack.includes(stacklit.framework)) {
        techStack.unshift(stacklit.framework);
      }

      // Build a goal from module purposes
      const purposes = Object.values(stacklit.modules ?? {})
        .map((m) => m.purpose)
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");

      const goal = purposes
        ? `Build a project with: ${purposes}`
        : `Build ${path.basename(this.config.projectPath)}`;

      return { goal, techStack };
    } catch {
      return null;
    }
  }

  // ─── Preflight check implementations ──────────────────────────────────────

  private async checkStateDir(): Promise<PreflightCheck> {
    try {
      await fsPromises.mkdir(this.config.stateDir, { recursive: true });
      const testFile = path.join(this.config.stateDir, ".write-test");
      await fsPromises.writeFile(testFile, "test", "utf-8");
      await fsPromises.unlink(testFile);
      return {
        name: "State directory writable",
        passed: true,
        message: this.config.stateDir,
        fatal: true,
      };
    } catch (err) {
      return {
        name: "State directory writable",
        passed: false,
        message: `Cannot write to ${this.config.stateDir}: ${err}`,
        fatal: true,
      };
    }
  }

  private async checkGit(): Promise<PreflightCheck> {
    const gitDir = path.join(this.config.projectPath, ".git");
    const exists = fs.existsSync(gitDir);
    return {
      name: "Git repository",
      passed: exists,
      message: exists
        ? `Found at ${gitDir}`
        : "No .git directory — git diff-based reconciliation will not work",
      fatal: false, // warning only — Duostack works without git but reconciliation is weaker
    };
  }

  private async checkStacklit(): Promise<PreflightCheck> {
    const exists = fs.existsSync(this.config.stacklit.jsonPath);
    return {
      name: "Stacklit index",
      passed: exists,
      message: exists
        ? `Found at ${this.config.stacklit.jsonPath}`
        : `stacklit.json not found — run: npx stacklit@${this.config.stacklitVersion} init --hook`,
      fatal: false, // Duostack works without Stacklit, just less token-efficient
    };
  }

  private async checkPort(): Promise<PreflightCheck> {
    const port = this.config.api.port;
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => {
        resolve({
          name: `Port ${port} available`,
          passed: false,
          message: `Port ${port} is in use — is Duostack already running? Use --port to change.`,
          fatal: true,
        });
      });
      server.once("listening", () => {
        server.close();
        resolve({
          name: `Port ${port} available`,
          passed: true,
          message: `Port ${port} is free`,
          fatal: true,
        });
      });
      server.listen(port, "127.0.0.1");
    });
  }

  private checkNodeVersion(): PreflightCheck {
    const version = process.version; // e.g. "v20.11.0"
    const major = parseInt(version.slice(1).split(".")[0] ?? "0", 10);
    const passed = major >= 20;
    return {
      name: "Node.js version",
      passed,
      message: passed
        ? `${version} ✓`
        : `${version} — Node.js 20+ required`,
      fatal: true,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createProjectInitializer(
  config: DuostackConfig
): ProjectInitializer {
  return new ProjectInitializer(config);
}

// ─── Pretty print preflight ───────────────────────────────────────────────────

export function printPreflight(result: PreflightResult): void {
  console.log("\n── Preflight checks ──────────────────────────\n");
  for (const check of result.checks) {
    const icon = check.passed ? "✓" : check.fatal ? "✗" : "⚠";
    const label = check.passed ? "" : check.fatal ? " (fatal)" : " (warning)";
    console.log(`  ${icon} ${check.name}${label}`);
    if (!check.passed) {
      console.log(`    → ${check.message}`);
    }
  }
  if (result.pass) {
    console.log("\n  All checks passed.\n");
  } else {
    console.log("\n  One or more fatal checks failed. Fix them and retry.\n");
  }
}
