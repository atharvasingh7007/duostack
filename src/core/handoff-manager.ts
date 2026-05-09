/**
 * handoff-manager.ts
 *
 * Handles the most critical part of Duostack: detecting when an agent
 * has gone silent and deterministically transferring its work to the other.
 *
 * Key design decisions:
 * - Death is detected by lease expiry, not self-reporting. An agent that
 *   has gone silent cannot tell anyone it's gone. The lease expiry is the
 *   only reliable signal.
 * - Reconciliation is mandatory on takeover. The fallback agent cannot
 *   blindly continue from the event log alone — it must verify intent
 *   against actual repo state (git diff + validation) first.
 * - Role swap is symmetric. Claude can become executor. Antigravity can
 *   become tactical planner. But architectural decisions always require
 *   Claude — Antigravity proposes, Claude records.
 * - Recovery is clean. When the primary agent returns, it reads the
 *   snapshot and resumes only NEW tasks — it doesn't reclaim tasks the
 *   fallback is actively working on.
 * - Exponential backoff on unavailable agent checks. If Antigravity has
 *   been down for a week, checking every 30s is pure waste.
 */

import { EventEmitter } from "node:events";
import type { EventStore } from "./event-store.js";
import type { SnapshotBuilder } from "./snapshot-builder.js";
import type { AgentId, AgentSnapshot } from "../schemas/agent.schema.js";
import type { Task, HandoffPayload } from "../schemas/task.schema.js";
import { TASK_ROUTING } from "../schemas/task.schema.js";
import { v4 as uuidv4 } from "uuid";

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_LEASE_DURATION_MS = 20 * 60 * 1000;  // 20 minutes
const LEASE_RENEWAL_THRESHOLD_MS = 5 * 60 * 1000;  // renew when < 5 min left
const CHECK_INTERVAL_MS = 30 * 1000;                // check every 30s

// Backoff for unavailable agent checks
const BACKOFF_STEPS: Record<number, number> = {
  3:  5  * 60 * 1000,   // after 3 failures → check every 5 min
  10: 60 * 60 * 1000,   // after 10 failures → check every 1 hour
  50: 6  * 60 * 60 * 1000, // after 50 failures → check every 6 hours
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HandoffDecision {
  taskId: string;
  fromAgent: AgentId;
  toAgent: AgentId;
  reason: HandoffReason;
  triggeredAt: string; // ISO 8601
  reconciliationRequired: boolean;
  lastKnownStepId: string | null;
  handoffPayload: HandoffPayload | null;
}

export type HandoffReason =
  | "lease_expired"           // agent stopped heartbeating
  | "agent_exhausted"         // token limit hit
  | "agent_context_saturated" // Claude context full
  | "manual_override"         // developer forced handoff
  | "agent_recovered"         // primary back, rebalancing work
  | "repeated_failures";      // task failed N times under same agent

export interface ReconciliationInstruction {
  taskId: string;
  stepId: string | null;
  lastIntentSummary: string;
  targetFiles: string[];
  validationCommands: string[];
  nextActionIfValidationPasses: string;
  nextActionIfValidationFails: string;
  gitDiffHash: string | null;
  contextForFallback: string;
  doNotTouch: string[];
}

export interface AgentFailureRecord {
  agentId: AgentId;
  failureCount: number;
  lastFailureAt: string;
  consecutiveFailures: number;
  backoffUntil: string | null; // ISO 8601 — don't check before this
}

// ─── Handoff manager ──────────────────────────────────────────────────────────

export class HandoffManager extends EventEmitter {
  private store: EventStore;
  private snapshots: SnapshotBuilder;
  private failureRecords: Map<AgentId, AgentFailureRecord> = new Map();
  private checkTimer: NodeJS.Timeout | null = null;
  private running: boolean = false;

  constructor(store: EventStore, snapshots: SnapshotBuilder) {
    super();
    this.store = store;
    this.snapshots = snapshots;
  }

  // ─── Start / stop ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleCheck();
    console.log("[handoff-manager] started — checking leases every 30s");
  }

  stop(): void {
    this.running = false;
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    console.log("[handoff-manager] stopped");
  }

  // ─── Main check loop ───────────────────────────────────────────────────────

  /**
   * Main check — runs every 30s (or on file-watcher trigger).
   * Checks all active task leases and agent health.
   */
  async runCheck(): Promise<HandoffDecision[]> {
    const decisions: HandoffDecision[] = [];

    const [tasksSnapshot, agentsSnapshot] = await Promise.all([
      this.snapshots.readTasksSnapshot(),
      this.snapshots.readAgentsSnapshot(),
    ]);

    if (!tasksSnapshot || !agentsSnapshot) return decisions;

    const now = new Date();

    // Check each active task lease
    const activeTasks = [
      ...tasksSnapshot.byStatus["claimed"],
      ...tasksSnapshot.byStatus["in_progress"],
    ];

    for (const taskId of activeTasks) {
      const task = tasksSnapshot.tasks[taskId];
      if (!task?.lease) continue;

      const leaseExpiry = new Date(task.lease.expiresAt);
      const msUntilExpiry = leaseExpiry.getTime() - now.getTime();

      // Lease has expired — agent is gone
      if (msUntilExpiry <= 0) {
        const decision = await this.handleLeaseExpired(task, agentsSnapshot.agents);
        if (decision) decisions.push(decision);
        continue;
      }

      // Lease expiring soon — renew if agent is still healthy
      if (msUntilExpiry < LEASE_RENEWAL_THRESHOLD_MS) {
        await this.maybeRenewLease(task, agentsSnapshot.agents);
      }
    }

    // Check for agents that have recovered
    await this.checkForRecoveredAgents(agentsSnapshot.agents);

    return decisions;
  }

  // ─── Lease expiry handler ──────────────────────────────────────────────────

  /**
   * Handle a task whose lease has expired.
   *
   * Process:
   * 1. Emit TaskLeaseExpired event
   * 2. Mark the holding agent as unavailable (observed)
   * 3. Determine fallback agent
   * 4. Build reconciliation instruction for fallback
   * 5. Emit handoff events
   * 6. Return decision for orchestrator to act on
   */
  private async handleLeaseExpired(
    task: Task,
    agents: Record<AgentId, AgentSnapshot>
  ): Promise<HandoffDecision | null> {
    if (!task.lease) return null;

    const dyingAgent = task.lease.claimedBy;
    const fallbackAgent = this.selectFallback(task, dyingAgent, agents);
    const now = new Date().toISOString();
    const correlationId = uuidv4();

    console.log(
      `[handoff-manager] lease expired — task=${task.taskId} agent=${dyingAgent} → ${fallbackAgent}`
    );

    // Record the failure
    this.recordFailure(dyingAgent);

    // Emit TaskLeaseExpired event
    await this.store.appendEvent({
      eventType: "TaskLeaseExpired",
      actor: "orchestrator",
      taskId: task.taskId,
      correlationId,
      payload: {
        taskId: task.taskId,
        wasClaimedBy: dyingAgent,
        expiredAt: now,
        handoffCount: task.lease.handoffCount,
        willReassign: fallbackAgent !== null,
      },
    });

    // Mark dying agent as unavailable
    await this.store.appendEvent({
      eventType: "AgentUnavailableObserved",
      actor: "orchestrator",
      correlationId,
      payload: {
        agentId: dyingAgent,
        reason: "lease_expired_no_renewal",
        confidence: "high",
        estimatedRecoveryAt: this.estimateRecovery(dyingAgent),
        failoverActivated: fallbackAgent !== null,
        failoverTo: fallbackAgent,
      },
    });

    if (!fallbackAgent) {
      console.warn(
        `[handoff-manager] no fallback available for task=${task.taskId} — marking blocked`
      );
      await this.store.appendEvent({
        eventType: "TaskBlocked",
        actor: "orchestrator",
        taskId: task.taskId,
        correlationId,
        payload: {
          taskId: task.taskId,
          blockedBy: dyingAgent,
          reason: "Both agents unavailable",
          suggestedResolution: "Wait for agent recovery or set manual override",
        },
      });
      await this.snapshots.rebuildAll();
      return null;
    }

    // Build reconciliation instruction — what the fallback must check
    const reconciliation = await this.buildReconciliationInstruction(task);

    // Build handoff payload
    const handoffPayload = this.buildHandoffPayload(
      task,
      dyingAgent,
      fallbackAgent,
      "lease_expired",
      reconciliation
    );

    // Emit TaskHandedOff
    await this.store.appendEvent({
      eventType: "TaskHandedOff",
      actor: "orchestrator",
      taskId: task.taskId,
      correlationId,
      payload: {
        taskId: task.taskId,
        handoff: handoffPayload,
      },
    });

    // Rebuild snapshots so fallback agent sees current state
    await this.snapshots.rebuildAll();

    const decision: HandoffDecision = {
      taskId: task.taskId,
      fromAgent: dyingAgent,
      toAgent: fallbackAgent,
      reason: "lease_expired",
      triggeredAt: now,
      reconciliationRequired: true,
      lastKnownStepId: task.currentStepId,
      handoffPayload,
    };

    // Emit event for orchestrator / API consumers
    this.emit("handoff", decision);

    return decision;
  }

  // ─── Manual handoff ────────────────────────────────────────────────────────

  /**
   * Manually trigger a handoff — called by CLI or developer override.
   * Used for: `duostack handoff --to claude`
   */
  async triggerManualHandoff(
    taskId: string,
    toAgent: AgentId,
    reason: string
  ): Promise<HandoffDecision | null> {
    const tasksSnapshot = await this.snapshots.readTasksSnapshot();
    const agentsSnapshot = await this.snapshots.readAgentsSnapshot();
    if (!tasksSnapshot || !agentsSnapshot) return null;

    const task = tasksSnapshot.tasks[taskId];
    if (!task) {
      console.error(`[handoff-manager] task not found: ${taskId}`);
      return null;
    }

    const fromAgent = task.lease?.claimedBy ?? task.assignedTo;
    if (!fromAgent) {
      console.error(`[handoff-manager] task ${taskId} has no current owner`);
      return null;
    }

    const correlationId = uuidv4();
    const now = new Date().toISOString();

    const reconciliation = await this.buildReconciliationInstruction(task);
    const handoffPayload = this.buildHandoffPayload(
      task,
      fromAgent,
      toAgent,
      "manual",
      reconciliation
    );

    await this.store.appendEvents(
      [
        {
          eventType: "ManualOverrideSet",
          actor: "developer",
          taskId,
          payload: {
            agentId: fromAgent,
            setBy: "developer",
            forcedStatus: "unavailable",
            reason,
            expiresAt: null,
          },
        },
        {
          eventType: "TaskHandedOff",
          actor: "developer",
          taskId,
          payload: {
            taskId,
            handoff: handoffPayload,
          },
        },
      ],
      correlationId
    );

    await this.snapshots.rebuildAll();

    const decision: HandoffDecision = {
      taskId,
      fromAgent,
      toAgent,
      reason: "manual_override",
      triggeredAt: now,
      reconciliationRequired: true,
      lastKnownStepId: task.currentStepId,
      handoffPayload,
    };

    this.emit("handoff", decision);
    return decision;
  }

  // ─── Agent recovery ────────────────────────────────────────────────────────

  /**
   * Check if a previously unavailable agent has come back.
   * Called on every check loop.
   *
   * Recovery is inferred — not self-reported. An agent is considered
   * recovered when it successfully completes an action (the API records
   * a successful event from that agent after it was marked unavailable).
   *
   * The orchestrator does NOT automatically reclaim tasks from the fallback.
   * The recovered agent picks up only NEW unassigned tasks.
   */
  private async checkForRecoveredAgents(
    agents: Record<AgentId, AgentSnapshot>
  ): Promise<void> {
    for (const [agentId, agent] of Object.entries(agents) as [AgentId, AgentSnapshot][]) {
      if (agent.status !== "unavailable") continue;

      // Check if backoff period has passed
      const failure = this.failureRecords.get(agentId);
      if (failure?.backoffUntil) {
        if (new Date(failure.backoffUntil) > new Date()) continue; // still in backoff
      }

      // We don't probe — we wait for the agent to signal via the API.
      // The API's POST /agents/status endpoint is how agents signal recovery.
      // This method just resets backoff counters if recovery was already recorded.
      if (agent.lastSuccessfulActionAt && agent.health === "normal") {
        this.resetFailureRecord(agentId);
        console.log(`[handoff-manager] agent recovered: ${agentId}`);
      }
    }
  }

  // ─── Lease renewal ────────────────────────────────────────────────────────

  /**
   * Renew a task lease if the holding agent is still healthy.
   * Only writes a LeaseRenewed event if the window actually moves.
   * This keeps the event log clean (no heartbeat noise).
   */
  private async maybeRenewLease(
    task: Task,
    agents: Record<AgentId, AgentSnapshot>
  ): Promise<void> {
    if (!task.lease) return;

    const agent = agents[task.lease.claimedBy];
    if (!agent || agent.status === "unavailable") return;

    // Agent is healthy — extend the lease
    const newExpiry = new Date(
      Date.now() + DEFAULT_LEASE_DURATION_MS
    ).toISOString();

    const previousExpiry = task.lease.expiresAt;

    // Only write event if window actually moves meaningfully (> 1 min change)
    const prevMs = new Date(previousExpiry).getTime();
    const newMs = new Date(newExpiry).getTime();
    if (newMs - prevMs < 60_000) return;

    await this.store.appendEvent({
      eventType: "LeaseRenewed",
      actor: "orchestrator",
      taskId: task.taskId,
      payload: {
        taskId: task.taskId,
        renewedBy: task.lease.claimedBy,
        previousExpiresAt: previousExpiry,
        newExpiresAt: newExpiry,
      },
    });
  }

  // ─── Fallback selection ────────────────────────────────────────────────────

  /**
   * Select the best fallback agent for a task.
   *
   * Rules:
   * 1. Never assign back to the agent that just failed
   * 2. Check efficiency — only assign fallback if above threshold
   * 3. Check if fallback-only-if-blocking applies
   * 4. Return null if no valid fallback exists
   */
  private selectFallback(
    task: Task,
    failedAgent: AgentId,
    agents: Record<AgentId, AgentSnapshot>
  ): AgentId | null {
    const routing = TASK_ROUTING[task.type];
    const candidate: AgentId =
      failedAgent === routing.primary ? routing.fallback : routing.primary;

    const candidateAgent = agents[candidate];
    if (!candidateAgent || candidateAgent.status === "unavailable") {
      return null; // both agents down
    }

    // Check efficiency threshold for fallback-only-if-blocking tasks
    if (routing.fallbackOnlyIfBlocking && failedAgent === routing.primary) {
      const isBlocking = task.blocks.length > 0;
      if (!isBlocking) {
        // Don't assign to inefficient fallback unless it's blocking something
        console.log(
          `[handoff-manager] task=${task.taskId} not blocking — deferring fallback assignment`
        );
        return null;
      }
    }

    return candidate;
  }

  // ─── Reconciliation instruction ────────────────────────────────────────────

  /**
   * Build what the fallback agent needs to safely take over.
   *
   * This is the bridge between "event log intent" and "repo reality".
   * The fallback agent MUST run reconciliation before continuing.
   *
   * Process:
   * 1. Read the last TaskStepPlanned for this task — that's the intent
   * 2. Read ArtifactsObserved — that's what actually changed
   * 3. Provide validation commands so fallback can verify repo state
   * 4. Give contextForFallback — critical details about implementation choices
   */
  private async buildReconciliationInstruction(
    task: Task
  ): Promise<ReconciliationInstruction> {
    // Get the last planned step — this is what was intended
    const taskEvents = await this.store.readTaskHistory(task.taskId);

    const lastPlanned = [...taskEvents]
      .reverse()
      .find((e) => e.eventType === "TaskStepPlanned");

    const lastArtifacts = [...taskEvents]
      .reverse()
      .find((e) => e.eventType === "ArtifactsObserved");

    // Get the current step if in progress
    const currentStep = task.currentStepId
      ? task.steps.find((s) => s.stepId === task.currentStepId)
      : null;

    // Best available intent
    const intentSummary =
      currentStep?.summary ??
      (lastPlanned?.eventType === "TaskStepPlanned"
        ? lastPlanned.payload.summary
        : "No step in progress — resume from last completed step");

    const targetFiles =
      currentStep?.targetFiles ??
      (lastPlanned?.eventType === "TaskStepPlanned"
        ? lastPlanned.payload.targetFiles
        : []);

    const validation =
      currentStep?.validation ??
      (lastPlanned?.eventType === "TaskStepPlanned"
        ? lastPlanned.payload.validation
        : []);

    const nextIfSuccess =
      currentStep?.nextActionIfSuccess ??
      (lastPlanned?.eventType === "TaskStepPlanned"
        ? lastPlanned.payload.nextActionIfSuccess
        : "Assess task state and continue");

    const nextIfFailure =
      currentStep?.nextActionIfFailure ??
      (lastPlanned?.eventType === "TaskStepPlanned"
        ? lastPlanned.payload.nextActionIfFailure
        : "Roll back and retry from last known good state");

    const gitDiffHash =
      lastArtifacts?.eventType === "ArtifactsObserved"
        ? lastArtifacts.payload.gitDiffHash
        : null;

    // Extract context from existing handoff payload if present
    const contextForFallback =
      task.handoff?.contextForFallback ??
      "No context recorded — inspect recent git commits and task steps for orientation";

    const doNotTouch = task.handoff?.doNotTouch ?? [];

    return {
      taskId: task.taskId,
      stepId: task.currentStepId,
      lastIntentSummary: intentSummary,
      targetFiles,
      validationCommands: validation,
      nextActionIfValidationPasses: nextIfSuccess,
      nextActionIfValidationFails: nextIfFailure,
      gitDiffHash,
      contextForFallback,
      doNotTouch,
    };
  }

  // ─── Handoff payload builder ───────────────────────────────────────────────

  private buildHandoffPayload(
    task: Task,
    fromAgent: AgentId,
    toAgent: AgentId,
    triggeredBy: HandoffPayload["triggeredBy"],
    reconciliation: ReconciliationInstruction
  ): HandoffPayload {
    const completedSteps = task.steps
      .filter((s) => s.status === "completed")
      .map((s) => s.stepId);

    const artifacts = task.steps
      .filter((s) => s.status === "completed")
      .flatMap((s) => s.result?.actualFilesChanged ?? []);

    return {
      fromAgent,
      toAgent,
      triggeredBy,
      handedOffAt: new Date().toISOString(),
      summary: `Task handed off from ${fromAgent} to ${toAgent}. Reason: ${triggeredBy}.`,
      completedStepIds: completedSteps,
      artifactsProduced: [...new Set(artifacts)], // deduplicate
      lastCompletedStepId: completedSteps.at(-1) ?? null,
      nextStepSummary: reconciliation.lastIntentSummary,
      nextTargetFiles: reconciliation.targetFiles,
      nextValidation: reconciliation.validationCommands,
      contextForFallback: reconciliation.contextForFallback,
      openQuestions: [],
      doNotTouch: reconciliation.doNotTouch,
    };
  }

  // ─── Failure tracking ──────────────────────────────────────────────────────

  private recordFailure(agentId: AgentId): void {
    const existing = this.failureRecords.get(agentId);
    const now = new Date().toISOString();

    const record: AgentFailureRecord = {
      agentId,
      failureCount: (existing?.failureCount ?? 0) + 1,
      lastFailureAt: now,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      backoffUntil: this.calculateBackoff(
        (existing?.consecutiveFailures ?? 0) + 1
      ),
    };

    this.failureRecords.set(agentId, record);

    if (record.backoffUntil) {
      console.log(
        `[handoff-manager] ${agentId} failure #${record.consecutiveFailures} — ` +
        `backing off until ${record.backoffUntil}`
      );
    }
  }

  private resetFailureRecord(agentId: AgentId): void {
    const existing = this.failureRecords.get(agentId);
    if (!existing) return;

    this.failureRecords.set(agentId, {
      ...existing,
      consecutiveFailures: 0,
      backoffUntil: null,
    });
  }

  /**
   * Exponential backoff based on consecutive failure count.
   * Returns ISO 8601 timestamp of when to next check, or null if no backoff.
   */
  private calculateBackoff(consecutiveFailures: number): string | null {
    let backoffMs: number | null = null;

    for (const [threshold, ms] of Object.entries(BACKOFF_STEPS)
      .map(([k, v]) => [parseInt(k), v] as [number, number])
      .sort((a, b) => b[0] - a[0])) {
      if (consecutiveFailures >= threshold) {
        backoffMs = ms;
        break;
      }
    }

    if (!backoffMs) return null;
    return new Date(Date.now() + backoffMs).toISOString();
  }

  /**
   * Estimate when an agent might recover.
   * For Antigravity: weekly reset pattern.
   * For Claude: unknown (context saturation is unpredictable).
   */
  private estimateRecovery(agentId: AgentId): string | null {
    if (agentId === "antigravity") {
      // Weekly reset — estimate 7 days from now as conservative upper bound
      const reset = new Date();
      reset.setDate(reset.getDate() + 7);
      return reset.toISOString();
    }
    return null; // Claude recovery is not predictable
  }

  // ─── Lease factory ─────────────────────────────────────────────────────────

  /**
   * Generate a new lease expiry for a task claim.
   * Called by the API when processing a TaskClaimed event.
   */
  static generateLeaseExpiry(): string {
    return new Date(Date.now() + DEFAULT_LEASE_DURATION_MS).toISOString();
  }

  // ─── Check scheduling ──────────────────────────────────────────────────────

  private scheduleCheck(): void {
    if (!this.running) return;

    this.checkTimer = setTimeout(async () => {
      try {
        await this.runCheck();
      } catch (err) {
        console.error("[handoff-manager] check error:", err);
      } finally {
        this.scheduleCheck(); // always reschedule
      }
    }, CHECK_INTERVAL_MS);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createHandoffManager(
  store: EventStore,
  snapshots: SnapshotBuilder
): HandoffManager {
  return new HandoffManager(store, snapshots);
}
