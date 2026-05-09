/**
 * orchestrator.ts
 *
 * The central coordinator. Runs as a long-lived process.
 * Combines polling (safety) with file-watching (responsiveness).
 *
 * Key design decisions:
 * - Hybrid polling + file-watch: file watchers alone are flaky on Windows
 *   and networked drives. Pure polling is safe but slow. Both together
 *   gives sub-second responsiveness with a 30s safety net.
 * - The orchestrator never acts on behalf of agents. It only:
 *     1. Detects events that require action (lease expiry, new pending tasks)
 *     2. Writes coordination events (handoffs, assignments)
 *     3. Triggers snapshot rebuilds
 * - Single instance: only one orchestrator should run per project.
 *   A lock file prevents double-starts.
 * - Graceful shutdown: SIGTERM / SIGINT are caught, in-flight operations
 *   complete, then process exits cleanly.
 */

import chokidar from "chokidar";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createEventStore } from "./event-store.js";
import { createSnapshotBuilder } from "./snapshot-builder.js";
import { createHandoffManager } from "./handoff-manager.js";
import { createTaskRouter } from "./task-router.js";
import { HandoffManager } from "./handoff-manager.js";
import type { EventStore } from "./event-store.js";
import type { SnapshotBuilder } from "./snapshot-builder.js";
import type { TaskRouter } from "./task-router.js";
import type { HandoffDecision } from "./handoff-manager.js";
import type { AgentId } from "../schemas/agent.schema.js";
import { v4 as uuidv4 } from "uuid";

// ─── Config ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;         // 30 second safety poll
const DEBOUNCE_MS = 500;                 // debounce file-watch events
const ORCHESTRATOR_LOCK = ".orchestrator.lock";

// ─── Orchestrator config ──────────────────────────────────────────────────────

export interface OrchestratorConfig {
  projectPath: string;    // root of the project repo
  stateDir: string;       // .duostack/state/
  stacklitPath: string;   // stacklit.json path (read-only)
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator extends EventEmitter {
  private config: OrchestratorConfig;
  private store!: EventStore;
  private snapshots!: SnapshotBuilder;
  private handoffManager!: HandoffManager;
  private router!: TaskRouter;

  private watcher: chokidar.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private lockPath: string;

  constructor(config: OrchestratorConfig) {
    super();
    this.config = config;
    this.lockPath = path.join(config.stateDir, ORCHESTRATOR_LOCK);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.acquireLock();
    await this.initComponents();
    this.registerShutdownHandlers();

    this.running = true;

    // Initial snapshot build on startup
    await this.snapshots.rebuildAll();

    // Start handoff manager (lease checks)
    this.handoffManager.start();

    // Start file watcher
    this.startFileWatcher();

    // Start polling loop
    this.schedulePoll();

    console.log(
      `[orchestrator] started — project=${this.config.projectPath}`
    );

    // Emit ready for API server to start accepting requests
    this.emit("ready");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log("[orchestrator] shutting down...");

    this.handoffManager.stop();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    await this.releaseLock();
    console.log("[orchestrator] stopped");
  }

  // ─── Component access (for API server) ────────────────────────────────────

  getStore(): EventStore { return this.store; }
  getSnapshots(): SnapshotBuilder { return this.snapshots; }
  getHandoffManager(): HandoffManager { return this.handoffManager; }
  getRouter(): TaskRouter { return this.router; }

  // ─── Main coordination cycle ───────────────────────────────────────────────

  /**
   * The core coordination cycle. Runs on every poll and file-watch trigger.
   *
   * Steps:
   * 1. Check if snapshots are stale — rebuild if so
   * 2. Run handoff checks (lease expiry detection)
   * 3. Route pending tasks
   * 4. Emit any decisions for API consumers
   */
  async runCycle(): Promise<void> {
    try {
      // Step 1: Rebuild snapshots if stale
      if (await this.snapshots.isStale()) {
        await this.snapshots.rebuildAll();
      }

      // Step 2: Check leases and trigger handoffs
      const handoffDecisions = await this.handoffManager.runCheck();
      for (const decision of handoffDecisions) {
        this.emit("handoff", decision);
        await this.logHandoffDecision(decision);
      }

      // Step 3: Route pending tasks
      const routingResults = await this.router.routeAllPending();
      for (const result of routingResults) {
        // Skip blocked/deferred results
        if (
          result.reason === "blocked_both_unavailable" ||
          result.reason === "blocked_fallback_not_eligible" ||
          result.reason === "primary_in_triage_defer_non_critical"
        ) {
          continue;
        }

        this.emit("taskRouted", result);
      }

      // Step 4: Detect batch groups for token-pressured agents
      const batchGroups = await this.router.detectBatchGroups();
      for (const group of batchGroups) {
        this.emit("batchReady", group);
      }

    } catch (err) {
      console.error("[orchestrator] cycle error:", err);
    }
  }

  // ─── Agent status update ───────────────────────────────────────────────────

  /**
   * Called by the API when an agent posts its health status.
   * This is how agents signal recovery, exhaustion, or triage mode.
   */
  async handleAgentStatusUpdate(
    agentId: AgentId,
    health: string,
    reason: string
  ): Promise<void> {
    const correlationId = uuidv4();

    if (health === "exhausted") {
      await this.store.appendEvent({
        eventType: "AgentUnavailableObserved",
        actor: "orchestrator",
        correlationId,
        payload: {
          agentId,
          reason: "execution_failure",
          confidence: "high",
          estimatedRecoveryAt: agentId === "antigravity"
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            : null,
          failoverActivated: true,
          failoverTo: agentId === "antigravity" ? "claude" : "antigravity",
        },
      });
    } else if (health === "normal") {
      // Check if agent was previously unavailable
      const agentsSnapshot = await this.snapshots.readAgentsSnapshot();
      const agent = agentsSnapshot?.agents[agentId];

      if (agent?.status === "unavailable") {
        // Agent is recovering
        const downSince = agent.lastObservedAt;
        const downtimeMs = Date.now() - new Date(downSince).getTime();
        const hours = Math.floor(downtimeMs / (1000 * 60 * 60));
        const days = Math.floor(hours / 24);
        const previousDowntime =
          days > 0 ? `${days} days ${hours % 24} hours` : `${hours} hours`;

        await this.store.appendEvent({
          eventType: "AgentRecovered",
          actor: agentId,
          correlationId,
          payload: {
            agentId,
            recoveredAt: new Date().toISOString(),
            previousDowntime,
            resumingFromCheckpoint: true,
            firstTaskId: null, // assigned by router on next cycle
          },
        });
      } else {
        await this.store.appendEvent({
          eventType: "AgentStatusObserved",
          actor: agentId,
          correlationId,
          payload: {
            agentId,
            health: "normal",
            confidence: "high",
            reason,
          },
        });
      }
    } else {
      // batching / triage / final_flush
      await this.store.appendEvent({
        eventType: "AgentHealthUpdated",
        actor: agentId,
        correlationId,
        payload: {
          agentId,
          previousHealth: "unknown",
          newHealth: health,
          triggeredBy: "self_report",
        },
      });
    }

    // Rebuild snapshots and re-run routing cycle
    await this.snapshots.rebuildAll();
    await this.runCycle();
  }

  // ─── Project checkpoint ────────────────────────────────────────────────────

  /**
   * Write a project checkpoint — called by Claude via MCP after
   * each major decision, batch of tasks, or review pass.
   * Ensures Claude context saturation is survivable at any point.
   */
  async writeCheckpoint(
    summary: string,
    milestone: string,
    activeAgent: AgentId
  ): Promise<void> {
    const tasksSnapshot = await this.snapshots.readTasksSnapshot();
    if (!tasksSnapshot) return;

    const openCount = tasksSnapshot.byStatus["pending"].length +
      tasksSnapshot.byStatus["claimed"].length +
      tasksSnapshot.byStatus["in_progress"].length;

    const completedCount = tasksSnapshot.byStatus["completed"].length;

    await this.store.appendEvent({
      eventType: "ProjectCheckpointWritten",
      actor: activeAgent,
      payload: {
        triggeredBy: "scheduled",
        currentMilestone: milestone,
        openTaskCount: openCount,
        completedTaskCount: completedCount,
        activeAgent,
        summary,
      },
    });

    await this.snapshots.rebuildAll();
    console.log(`[orchestrator] checkpoint written by ${activeAgent}`);
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  private async initComponents(): Promise<void> {
    this.store = await createEventStore(this.config.stateDir);
    this.snapshots = createSnapshotBuilder(this.config.stateDir, this.store);
    this.handoffManager = createHandoffManager(this.store, this.snapshots);
    this.router = createTaskRouter(this.snapshots);

    // Forward handoff events
    this.handoffManager.on("handoff", (decision: HandoffDecision) => {
      this.emit("handoff", decision);
    });
  }

  /**
   * Initialize components only — no poll loop, no file watcher, no lock.
   * For use in tests and programmatic API server creation where the full
   * orchestrator lifecycle is not needed.
   */
  async initOnly(): Promise<void> {
    await this.initComponents();
    await this.snapshots.rebuildAll();
  }

  // ─── File watcher ──────────────────────────────────────────────────────────

  /**
   * Watch events.jsonl for changes.
   * When a new event is appended (by the API), trigger a coordination cycle.
   * Debounced to avoid thrashing on rapid appends.
   */
  private startFileWatcher(): void {
    const eventsPath = path.join(this.config.stateDir, "events.jsonl");

    this.watcher = chokidar.watch(eventsPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      // Windows compatibility
      usePolling: process.platform === "win32",
      interval: 500,
    });

    this.watcher.on("change", () => {
      // Debounce — don't run cycle on every character of a large event
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(async () => {
        await this.runCycle();
      }, DEBOUNCE_MS);
    });

    this.watcher.on("error", (err) => {
      console.error("[orchestrator] file watcher error:", err);
    });

    console.log(`[orchestrator] watching ${eventsPath}`);
  }

  // ─── Poll loop ─────────────────────────────────────────────────────────────

  private schedulePoll(): void {
    if (!this.running) return;

    this.pollTimer = setTimeout(async () => {
      await this.runCycle();
      this.schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  // ─── Lock management ───────────────────────────────────────────────────────

  private async acquireLock(): Promise<void> {
    if (fs.existsSync(this.lockPath)) {
      try {
        const pid = parseInt(
          await fsPromises.readFile(this.lockPath, "utf-8"),
          10
        );
        try {
          process.kill(pid, 0);
          throw new Error(
            `[orchestrator] another instance is already running (PID ${pid}). ` +
            `Run 'duostack stop --project ${this.config.projectPath}' first.`
          );
        } catch (killErr: unknown) {
          if (
            killErr instanceof Error &&
            "code" in killErr &&
            (killErr as NodeJS.ErrnoException).code === "ESRCH"
          ) {
            // Process is dead — stale lock
            console.warn("[orchestrator] removing stale lock file");
            await fsPromises.unlink(this.lockPath).catch(() => {});
          } else {
            throw killErr;
          }
        }
      } catch (readErr) {
        // Can't read lock — remove it
        await fsPromises.unlink(this.lockPath).catch(() => {});
      }
    }

    await fsPromises.writeFile(this.lockPath, process.pid.toString(), "utf-8");
  }

  private async releaseLock(): Promise<void> {
    await fsPromises.unlink(this.lockPath).catch(() => {});
  }

  // ─── Shutdown handlers ─────────────────────────────────────────────────────

  private registerShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n[orchestrator] received ${signal} — shutting down`);
      await this.stop();
      process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT",  () => void shutdown("SIGINT"));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async logHandoffDecision(decision: HandoffDecision): Promise<void> {
    console.log(
      `[orchestrator] handoff: task=${decision.taskId} ` +
      `${decision.fromAgent} → ${decision.toAgent} ` +
      `reason=${decision.reason} ` +
      `reconciliation_required=${decision.reconciliationRequired}`
    );
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export async function createOrchestrator(
  config: OrchestratorConfig
): Promise<Orchestrator> {
  const orchestrator = new Orchestrator(config);
  return orchestrator;
}
