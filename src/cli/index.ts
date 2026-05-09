#!/usr/bin/env node
/**
 * cli/index.ts
 *
 * The duostack CLI.
 *
 * Commands:
 *   duostack init --project <path>        Bootstrap .duostack/ in a project
 *   duostack serve --project <path>       Start orchestrator + API + MCP server
 *   duostack status --project <path>      Show current agent health and task state
 *   duostack handoff --to <agent> --project <path>  Force a handoff
 *   duostack version                      Print version
 */

import { execSync } from "node:child_process";
import { Command } from "commander";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createOrchestrator } from "../core/orchestrator.js";
import { startApiServer, DEFAULT_PORT } from "../api/server.js";
import { startMcpServer } from "../mcp/server.js";

const VERSION = "0.1.0";

const program = new Command();

program
  .name("duostack")
  .description("Two-agent orchestration: Claude Desktop + Antigravity")
  .version(VERSION);

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Bootstrap .duostack/ in a project repo")
  .requiredOption("--project <path>", "Path to the project repo")
  .option("--stacklit-version <ver>", "Stacklit version to pin", "0.3.0")
  .option("--goal <text>", "Project goal description")
  .option("--skip-preflight", "Skip preflight checks", false)
  .action(async (opts: {
    project: string;
    stacklitVersion: string;
    goal?: string;
    skipPreflight: boolean;
  }) => {
    const projectPath = path.resolve(opts.project);

    if (!fs.existsSync(projectPath)) {
      console.error(`Project path does not exist: ${projectPath}`);
      process.exit(1);
    }

    console.log(`\nInitializing Duostack in: ${projectPath}`);
    console.log("─".repeat(50));

    const duostackDir = path.join(projectPath, ".duostack");
    const stateDir = path.join(duostackDir, "state");
    const antigravityDir = path.join(duostackDir, "antigravity", "skills");

    // Create directories
    await fsPromises.mkdir(stateDir, { recursive: true });
    await fsPromises.mkdir(antigravityDir, { recursive: true });

    // Initialize state files
    await fsPromises.writeFile(
      path.join(stateDir, "events.jsonl"),
      "",
      "utf-8"
    );

    // Build and write config
    const { defaultConfig, ConfigLoader } = await import("../core/config.js");
    const config = defaultConfig(projectPath);
    config.stacklitVersion = opts.stacklitVersion;
    const configLoader = new ConfigLoader(projectPath);
    await configLoader.write(config);

    // Write decisions.md
    await fsPromises.writeFile(
      path.join(duostackDir, "decisions.md"),
      `# Duostack — Architectural Decisions\n\n` +
      `*Record all significant architectural decisions here using \`ds_record_decision\`.*\n\n` +
      `---\n`,
      "utf-8"
    );

    // Write Antigravity rules.md and skills
    await writeAntigravityRules(antigravityDir, projectPath);
    await writeAntigravitySkills(antigravityDir);

    // Write Claude Desktop MCP config snippet
    await writeClaudeConfig(duostackDir, projectPath);

    // Write .gitignore additions
    await writeGitignore(projectPath);

    // Run preflight checks
    if (!opts.skipPreflight) {
      const { createProjectInitializer, printPreflight } = await import("../core/project-init.js");
      const initializer = createProjectInitializer(config);
      const preflight = await initializer.runPreflight();
      printPreflight(preflight);
      if (!preflight.pass) {
        console.error("Fix the fatal preflight issues above and re-run init.");
        process.exit(1);
      }
    }

    // Write the ProjectInitialized event — canonical start of project history
    const { createProjectInitializer } = await import("../core/project-init.js");
    const initializer = createProjectInitializer(config);
    const initResult = await initializer.initialize(
      opts.goal ? { goal: opts.goal } : {}
    );

    if (initResult.alreadyInitialized) {
      console.log("✓ Project already initialized — skipping event write");
    } else {
      console.log(`✓ Project initialized: ${initResult.projectName}`);
      console.log(`  Goal: ${initResult.goal}`);
      if (initResult.techStack.length > 0) {
        console.log(`  Stack: ${initResult.techStack.join(", ")}`);
      }
      if (initResult.warnings.length > 0) {
        for (const w of initResult.warnings) {
          console.log(`  ⚠ ${w}`);
        }
      }
    }

    console.log("\n✓ Files created:");
    console.log(`  ${duostackDir}/`);
    console.log(`  ├── duostack.config.json`);
    console.log(`  ├── decisions.md`);
    console.log(`  ├── state/events.jsonl`);
    console.log(`  └── antigravity/`);
    console.log(`      ├── rules.md`);
    console.log(`      └── skills/`);
    console.log(`          ├── orient.md`);
    console.log(`          ├── claim_task.md`);
    console.log(`          ├── plan_step.md`);
    console.log(`          └── complete_step.md`);

    console.log(`\n✓ Claude Desktop MCP config: ${path.join(duostackDir, "claude-mcp.json")}`);
    console.log(`  → Merge mcpServers block into your claude_desktop_config.json`);

    console.log(`\nNext steps:`);
    console.log(`  1. npx stacklit@${opts.stacklitVersion} init --hook`);
    console.log(`  2. duostack serve --project ${projectPath}`);
    console.log(`  3. Open Claude Desktop — Duostack tools will appear`);
    console.log(`  4. First session: ds_agent_status(normal) → ds_orient() → ds_codebase(normal)\n`);
  });

// ─── serve ────────────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the Duostack orchestrator, API server, and MCP server")
  .requiredOption("--project <path>", "Path to the project repo")
  .option("--port <number>", "API server port", String(DEFAULT_PORT))
  .option("--mcp", "Also start the MCP server (for Claude Desktop)", false)
  .option("--skip-preflight", "Skip preflight checks", false)
  .action(async (opts: {
    project: string;
    port: string;
    mcp: boolean;
    skipPreflight: boolean;
  }) => {
    const projectPath = path.resolve(opts.project);
    const stateDir = path.join(projectPath, ".duostack", "state");
    const stacklitPath = path.join(projectPath, "stacklit.json");

    if (!fs.existsSync(stateDir)) {
      console.error(
        `No .duostack/state found at ${projectPath}.\n` +
        `Run: duostack init --project ${projectPath}`
      );
      process.exit(1);
    }

    process.env["DUOSTACK_PROJECT_PATH"] = projectPath;

    console.log(`\nStarting Duostack for: ${projectPath}`);
    console.log("─".repeat(50));

    // Load config
    const { loadConfig } = await import("../core/config.js");
    const config = await loadConfig(projectPath);
    const port = parseInt(opts.port, 10);
    config.api.port = port; // CLI port overrides config

    // Run preflight
    if (!opts.skipPreflight) {
      const { createProjectInitializer, printPreflight } = await import("../core/project-init.js");
      const initializer = createProjectInitializer(config);
      const preflight = await initializer.runPreflight();
      // Only print if there are failures — skip noise on clean startup
      const hasIssues = preflight.checks.some((c) => !c.passed);
      if (hasIssues) {
        printPreflight(preflight);
        if (!preflight.pass) {
          console.error("Fix fatal preflight issues above before serving.");
          process.exit(1);
        }
      }

      // Auto-initialize if not already done
      const initResult = await initializer.initialize();
      if (!initResult.alreadyInitialized) {
        console.log(`[serve] project initialized: ${initResult.projectName}`);
      }
    }

    // Create orchestrator
    const orchestrator = await createOrchestrator({
      projectPath,
      stateDir,
      stacklitPath,
    });

    // Create Stacklit bridge
    const { createStacklitBridge } = await import("../core/stacklit-bridge.js");
    const stacklit = createStacklitBridge(config);
    const stacklitAvailable = stacklit.isAvailable();
    if (!stacklitAvailable) {
      console.log("[serve] ⚠ stacklit.json not found — run: npx stacklit@0.3.0 init --hook");
    }

    // Create efficiency tracker (initialized after orchestrator start)
    const { createEfficiencyTracker } = await import("../core/efficiency-tracker.js");

    // Start API server (pass stacklit + efficiency)
    const { createEventStore } = await import("../core/event-store.js");
    // Efficiency tracker needs the store — we'll create it after orchestrator starts
    // For now pass undefined, update after start
    startApiServer(orchestrator, port, stacklit);

    // Start orchestrator (begins polling + file watching)
    await orchestrator.start();

    // Now wire efficiency tracker using the live store
    const efficiencyTracker = createEfficiencyTracker(
      orchestrator.getStore(),
      config
    );

    // Schedule periodic efficiency analysis (every 30 min)
    if (config.efficiency.trackingEnabled) {
      setInterval(async () => {
        try {
          await efficiencyTracker.generateReport();
        } catch {
          // Non-fatal — efficiency tracking is best-effort
        }
      }, 30 * 60 * 1000);
    }

    // Optionally start MCP server
    if (opts.mcp) {
      console.log("[cli] starting MCP server for Claude Desktop...");
      startMcpServer().catch((err) => {
        console.error("[mcp] server error:", err);
      });
    }

    console.log(`\nDuostack running:`);
    console.log(`  API:       http://127.0.0.1:${port}`);
    console.log(`  Dashboard: http://127.0.0.1:${port}/dashboard`);
    console.log(`  Stacklit:  ${stacklitAvailable ? "✓ available" : "✗ not found"}`);
    console.log(`  MCP:       ${opts.mcp ? "running (stdio)" : "run with --mcp to enable"}`);
    console.log(`\nPress Ctrl+C to stop.\n`);
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show current agent health and task summary")
  .option("--project <path>", "Path to the project repo")
  .option("--port <number>", "API server port", String(DEFAULT_PORT))
  .action(async (opts: { project?: string; port: string }) => {
    const port = opts.port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Health check
      const healthRes = await fetch(`${baseUrl}/health`);
      if (!healthRes.ok) {
        console.error("Duostack API is not running. Start with: duostack serve --project <path>");
        process.exit(1);
      }
      const health = await healthRes.json() as { eventLogVersion: number };

      // Agents
      const agentsRes = await fetch(`${baseUrl}/agents`);
      const agentsData = await agentsRes.json() as {
        agents: Record<string, {
          status: string; health: string;
          tokenHealth: { level: string; estimatedResetAt: string | null };
          activeLease: { taskId: string; expiresAt: string } | null;
        }>
      };

      // Tasks summary
      const tasksRes = await fetch(`${baseUrl}/snapshot/tasks?scope=active&limit=20`);
      const tasksData = await tasksRes.json() as {
        total: number;
        byStatus: Record<string, string[]>;
        criticalPath: string[];
      };

      console.log("\n── Duostack Status ─────────────────────────────\n");
      console.log(`Event log version: ${health.eventLogVersion}`);
      console.log("");

      // Agent health
      for (const [agentId, agent] of Object.entries(agentsData.agents)) {
        const statusIcon = agent.status === "available" ? "●" : "○";
        console.log(`${statusIcon} ${agentId.padEnd(14)} ${agent.health.padEnd(12)} ${agent.status}`);
        if (agent.activeLease) {
          const expiresAt = new Date(agent.activeLease.expiresAt);
          const minsLeft = Math.round((expiresAt.getTime() - Date.now()) / 60000);
          console.log(`  └─ lease on ${agent.activeLease.taskId} (${minsLeft}m left)`);
        }
        if (agent.tokenHealth.estimatedResetAt) {
          const reset = new Date(agent.tokenHealth.estimatedResetAt);
          console.log(`  └─ estimated reset: ${reset.toLocaleDateString()}`);
        }
      }

      console.log("");

      // Task counts
      const bs = tasksData.byStatus;
      console.log(`Tasks:`);
      console.log(`  pending       ${(bs["pending"] ?? []).length}`);
      console.log(`  in_progress   ${(bs["in_progress"] ?? []).length}`);
      console.log(`  blocked       ${(bs["blocked"] ?? []).length}`);
      console.log(`  completed     ${(bs["completed"] ?? []).length}`);
      console.log(`  handoff       ${(bs["handoff_pending"] ?? []).length}`);

      if (tasksData.criticalPath.length > 0) {
        console.log(`\nCritical path: ${tasksData.criticalPath.slice(0, 3).join(" → ")}`);
      }

      console.log("");
    } catch {
      console.error("Could not connect to Duostack API. Is it running?");
      console.error(`Try: duostack serve --project <path>`);
      process.exit(1);
    }
  });

// ─── handoff ──────────────────────────────────────────────────────────────────

program
  .command("handoff")
  .description("Force a task handoff between agents")
  .requiredOption("--task <id>", "Task ID to hand off")
  .requiredOption("--to <agent>", "Target agent (claude | antigravity)")
  .option("--reason <text>", "Reason for handoff", "Manual CLI handoff")
  .option("--port <number>", "API server port", String(DEFAULT_PORT))
  .action(async (opts: {
    task: string; to: string; reason: string; port: string
  }) => {
    if (opts.to !== "claude" && opts.to !== "antigravity") {
      console.error("--to must be 'claude' or 'antigravity'");
      process.exit(1);
    }

    const baseUrl = `http://127.0.0.1:${opts.port}`;

    try {
      const res = await fetch(`${baseUrl}/tasks/${opts.task}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: opts.to === "claude" ? "antigravity" : "claude",
          toAgent: opts.to,
          reason: opts.reason,
          contextForFallback: "Manual CLI handoff — inspect task history for context.",
        }),
      });

      const data = await res.json() as { decision?: unknown; error?: string };

      if (!res.ok) {
        console.error(`Handoff failed: ${data.error}`);
        process.exit(1);
      }

      console.log(`\n✓ Handoff initiated: task ${opts.task} → ${opts.to}`);
      console.log(JSON.stringify(data.decision, null, 2));
    } catch {
      console.error("Could not connect to Duostack API.");
      process.exit(1);
    }
  });

// ─── efficiency ───────────────────────────────────────────────────────────────

program
  .command("efficiency")
  .description("Analyze token efficiency and detect waste patterns")
  .requiredOption("--project <path>", "Path to the project repo")
  .option("--json", "Output as JSON", false)
  .action(async (opts: { project: string; json: boolean }) => {
    const projectPath = path.resolve(opts.project);
    const stateDir = path.join(projectPath, ".duostack", "state");

    if (!fs.existsSync(stateDir)) {
      console.error(`No .duostack/state found. Run: duostack init --project ${projectPath}`);
      process.exit(1);
    }

    const { createEventStore } = await import("../core/event-store.js");
    const { createEfficiencyTracker } = await import("../core/efficiency-tracker.js");
    const { loadConfig } = await import("../core/config.js");

    const config = await loadConfig(projectPath);
    const store = await createEventStore(stateDir);
    const tracker = createEfficiencyTracker(store, config);
    const report = await tracker.generateReport();

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log("\n── Duostack Efficiency Report ──────────────────\n");
    console.log(`Generated: ${new Date(report.generatedAt).toLocaleString()}`);
    console.log(`Events analyzed: ${report.period.toEvent}`);
    console.log("");

    // Agent summary
    console.log("Agents:");
    for (const [id, agent] of Object.entries(report.byAgent)) {
      console.log(`  ${id}`);
      console.log(`    completed:     ${agent.tasksCompleted}`);
      console.log(`    handoffs:      ${agent.handoffCount}`);
      console.log(`    blocks:        ${agent.blockCount}`);
      console.log(`    lease expiries: ${agent.leaseExpiryCount}`);
    }
    console.log("");

    // Task type summary
    if (Object.keys(report.byTaskType).length > 0) {
      console.log("Task types:");
      for (const [type, stats] of Object.entries(report.byTaskType)) {
        const fallbackPct = stats.count > 0
          ? Math.round((stats.completedByFallback / stats.count) * 100)
          : 0;
        console.log(
          `  ${type.padEnd(14)} ${stats.count} tasks  ` +
          `fallback rate: ${fallbackPct}%  ` +
          `avg attempts: ${stats.averageAttempts.toFixed(1)}`
        );
      }
      console.log("");
    }

    // Waste events
    if (report.wasteEvents.length > 0) {
      console.log(`Waste events (${report.wasteEvents.length}):`);
      for (const w of report.wasteEvents) {
        const impact = w.impact === "high" ? "!" : w.impact === "medium" ? "~" : " ";
        console.log(`  [${impact}] ${w.type}`);
        console.log(`      ${w.description}`);
      }
      console.log("");
    }

    // Recommendations
    console.log("Recommendations:");
    for (const rec of report.recommendations) {
      console.log(`  → ${rec}`);
    }
    console.log("");
  });

// ─── dashboard ────────────────────────────────────────────────────────────────

program
  .command("dashboard")
  .description("Open the live status dashboard in browser")
  .option("--port <number>", "API server port", String(DEFAULT_PORT))
  .action((opts: { port: string }) => {
    const url = `http://127.0.0.1:${opts.port}/dashboard`;
    console.log(`\nDuostack dashboard: ${url}`);

    // Open in default browser
    const platform = process.platform;
    try {
      if (platform === "win32") execSync(`start ${url}`);
      else if (platform === "darwin") execSync(`open ${url}`);
      else execSync(`xdg-open ${url}`);
    } catch {
      console.log("Could not open browser automatically. Visit the URL above.");
    }
  });

// ─── Template writers ──────────────────────────────────────────────────────────

async function writeAntigravityRules(
  skillsDir: string,
  projectPath: string
): Promise<void> {
  const rulesPath = path.join(path.dirname(skillsDir), "rules.md");

  await fsPromises.writeFile(rulesPath, `# Duostack — Antigravity Rules

## Your role
You are the **executor and tester** in a two-agent system.
- Claude Desktop is the planner, architect, and reviewer.
- You build, test, verify, and operate the browser.
- In fallback mode (when Claude is unavailable), you may do tactical planning
  for short-horizon work only. You CANNOT record architectural decisions —
  use POST /events with eventType "DecisionProposed" and Claude will review.

## Mandatory preflight (run before every task)

### 1. Check your token health
POST http://127.0.0.1:${DEFAULT_PORT}/agents/status
{ "agent": "antigravity", "health": "normal", "reason": "session start" }

### 2. Orientate
GET http://127.0.0.1:${DEFAULT_PORT}/snapshot/orientation?agent=antigravity

### 3. Read Stacklit (adapt to token health)
- Token health normal/batching → read stacklit.json (~4k tokens)
- Token health triage → run: stacklit derive (~250 tokens)
- Token health final_flush → skip UNLESS touching an unfamiliar module

### 4. Claim your task
POST http://127.0.0.1:${DEFAULT_PORT}/tasks/:id/claim
{ "agent": "antigravity" }

## Before every step — write intent first

POST http://127.0.0.1:${DEFAULT_PORT}/tasks/:id/progress
{
  "agent": "antigravity",
  "step": {
    "stepId": "step_001",
    "stepNumber": 1,
    "summary": "Implement JWT middleware in src/auth/middleware.ts",
    "targetFiles": ["src/auth/middleware.ts"],
    "validation": ["pnpm test auth", "pnpm typecheck"],
    "nextActionIfSuccess": "Implement refresh token rotation",
    "nextActionIfFailure": "Roll back middleware.ts and retry with simpler approach",
    "isIdempotent": true
  }
}

## After every step — record result

POST http://127.0.0.1:${DEFAULT_PORT}/tasks/:id/complete
{
  "agent": "antigravity",
  "stepId": "step_001",
  "actualFilesChanged": ["src/auth/middleware.ts"],
  "gitDiffHash": "abc123",
  "validationPassed": true,
  "notes": "Used express-jwt v9 — see package.json"
}

## Token health levels
- normal     → work normally
- batching   → group 3-5 tasks, read stacklit derive not full index
- triage     → critical-path tasks only
- final_flush → write handoffs for all active tasks, then stop
- exhausted  → POST status and stop

## When you hit your limit
1. POST /agents/status { health: "final_flush" }
2. For each active task: POST /tasks/:id/handoff with full contextForFallback
3. POST /agents/status { health: "exhausted" }
4. Stop. Claude takes over.

## When you return after a weekly reset
1. POST /agents/status { health: "normal", reason: "recovered after weekly reset" }
2. GET /snapshot/orientation?agent=antigravity
3. Check tasks in handoff_pending status — claim them and reconcile:
   GET /tasks/:id/reconcile
   Run: git diff <gitDiffHash> to verify last known state
   Run validation commands
   Continue from nextActionIfSuccess or nextActionIfFailure

## API base URL
http://127.0.0.1:${DEFAULT_PORT}

## Project path
${projectPath}
`,
    "utf-8"
  );
}

async function writeAntigravitySkills(skillsDir: string): Promise<void> {
  // orient.md
  await fsPromises.writeFile(
    path.join(skillsDir, "orient.md"),
    `# Skill: orient
Get session-start orientation from Duostack.

## When to use
At the start of every Antigravity session, before claiming any task.

## Steps
1. POST http://127.0.0.1:${DEFAULT_PORT}/agents/status
   Body: { "agent": "antigravity", "health": "normal", "reason": "session start" }

2. GET http://127.0.0.1:${DEFAULT_PORT}/snapshot/orientation?agent=antigravity

3. Read the response:
   - goal: what the project is building
   - currentMilestone: where we are
   - agentHealth: both agents' status
   - myActiveTasks: tasks already assigned to you
   - availableTasks: tasks you can claim

4. Read Stacklit based on token health (from agentHealth.antigravity.health)
`,
    "utf-8"
  );

  // claim_task.md
  await fsPromises.writeFile(
    path.join(skillsDir, "claim_task.md"),
    `# Skill: claim_task
Claim a task and start a lease.

## When to use
After orient, when you have a task to work on.

## Steps
1. Verify dependencies are satisfied (dependsOn tasks are completed)
2. POST http://127.0.0.1:${DEFAULT_PORT}/tasks/:taskId/claim
   Body: { "agent": "antigravity" }
3. Note the leaseExpiresAt — your lease lasts 20 minutes
4. Call plan_step skill before starting any work
`,
    "utf-8"
  );

  // plan_step.md
  await fsPromises.writeFile(
    path.join(skillsDir, "plan_step.md"),
    `# Skill: plan_step
Write step intent BEFORE executing. Required before every step.

## When to use
Before every unit of work. This is the most important skill.
If your session ends unexpectedly, Claude uses this to resume.

## Steps
1. Decompose the task into the smallest safe step
2. POST http://127.0.0.1:${DEFAULT_PORT}/tasks/:taskId/progress
   Body: {
     "agent": "antigravity",
     "step": {
       "stepId": "step_001",
       "stepNumber": 1,
       "summary": "exactly what this step does",
       "targetFiles": ["src/..."],
       "validation": ["pnpm test <module>"],
       "nextActionIfSuccess": "what to do next",
       "nextActionIfFailure": "explicit rollback path",
       "isIdempotent": true
     }
   }
3. Then execute the step
4. Then call complete_step skill
`,
    "utf-8"
  );

  // complete_step.md
  await fsPromises.writeFile(
    path.join(skillsDir, "complete_step.md"),
    `# Skill: complete_step
Record step result after validation.

## When to use
After every step completes and validation passes.
Also use when validation fails — record it so Claude can see what happened.

## Steps
1. Run validation commands from the step plan
2. Record the git diff hash: git rev-parse HEAD
3. POST http://127.0.0.1:${DEFAULT_PORT}/tasks/:taskId/complete
   Body: {
     "agent": "antigravity",
     "stepId": "step_001",
     "actualFilesChanged": ["src/..."],
     "gitDiffHash": "<git hash>",
     "validationPassed": true | false,
     "notes": "anything Claude should know",
     "taskComplete": true | false
   }
4. If taskComplete true: task is done, pick up the next one
5. If validationPassed false: follow nextActionIfFailure from the step plan
`,
    "utf-8"
  );
}

async function writeClaudeConfig(
  duostackDir: string,
  projectPath: string
): Promise<void> {
  const config = {
    _comment: "Merge the mcpServers block into your claude_desktop_config.json",
    mcpServers: {
      stacklit: {
        command: "stacklit",
        args: ["serve"],
        _comment: "Stacklit MCP — codebase navigation (run: npx stacklit@0.3.0 init first)",
      },
      duostack: {
        command: "node",
        args: [
          path.join(
            path.dirname(path.dirname(duostackDir)),
            "node_modules",
            ".bin",
            "duostack"
          ),
          "serve",
          "--project",
          projectPath,
          "--mcp",
        ],
        env: {
          DUOSTACK_PROJECT_PATH: projectPath,
        },
        _comment: "Duostack MCP — orchestration tools (ds_orient, ds_plan_step, etc.)",
      },
    },
  };

  await fsPromises.writeFile(
    path.join(duostackDir, "claude-mcp.json"),
    JSON.stringify(config, null, 2),
    "utf-8"
  );
}

async function writeGitignore(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, ".gitignore");
  const additions = `
# Duostack
.duostack/state/.orchestrator.lock
.duostack/state/.events.lock
.duostack/state/*.tmp
`;

  try {
    if (fs.existsSync(gitignorePath)) {
      const existing = await fsPromises.readFile(gitignorePath, "utf-8");
      if (!existing.includes("# Duostack")) {
        await fsPromises.appendFile(gitignorePath, additions, "utf-8");
      }
    } else {
      await fsPromises.writeFile(gitignorePath, additions.trim() + "\n", "utf-8");
    }
  } catch {
    // Non-fatal — .gitignore may be read-only
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

program.parse(process.argv);
