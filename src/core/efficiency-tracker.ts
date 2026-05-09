/**
 * core/efficiency-tracker.ts
 *
 * Tracks how tokens are being spent and surfaces waste patterns.
 * Writes to efficiency.json — not to events.jsonl (it's observability data,
 * not coordination state).
 *
 * Key design decisions:
 * - Efficiency data is NOT part of the event log. It's a separate concern.
 *   The event log records what happened. efficiency.json records how efficiently.
 * - Tracked automatically from events — agents don't manually report spend.
 *   The tracker reads events.jsonl and infers spend from event patterns.
 * - Waste patterns detected:
 *   - Clarification events (TaskBlocked with "unclear" reason) → ambiguous steps
 *   - Handoff loops (task handed off > 2 times) → coordination failure
 *   - High attempt counts (task claimed > 3 times) → step not idempotent
 *   - Missing step plans (TaskStepStarted without TaskStepPlanned) → intent skipped
 */

import fsPromises from "node:fs/promises";
import path from "node:path";
import type { EventStore } from "./event-store.js";
import type { DuostackConfig } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EfficiencyReport {
  generatedAt: string;
  period: {
    fromEvent: number;
    toEvent: number;
  };
  byAgent: Record<string, AgentEfficiency>;
  byTaskType: Record<string, TaskTypeEfficiency>;
  wasteEvents: WasteEvent[];
  recommendations: string[];
}

export interface AgentEfficiency {
  agentId: string;
  tasksCompleted: number;
  tasksHandedOff: number;
  averageStepsPerTask: number;
  handoffCount: number;
  blockCount: number;
  leaseExpiryCount: number;
  // Estimated token categories
  estimatedTokensOnOrientation: number;
  estimatedTokensOnExecution: number;
  estimatedTokensOnHandoffs: number;
}

export interface TaskTypeEfficiency {
  type: string;
  count: number;
  completedByPrimary: number;
  completedByFallback: number;
  averageAttempts: number;
  handoffRate: number; // 0-1
}

export interface WasteEvent {
  eventId: string;
  timestamp: string;
  type: WasteType;
  taskId: string | null;
  description: string;
  impact: "high" | "medium" | "low";
}

export type WasteType =
  | "missing_step_plan"     // TaskStepStarted without preceding TaskStepPlanned
  | "handoff_loop"          // same task handed off > 2 times
  | "high_attempt_count"    // task claimed > 3 times
  | "ambiguous_block"       // TaskBlocked with vague reason
  | "orphaned_lease"        // lease expired with no progress events
  | "checkpoint_skipped";   // many decisions without a checkpoint

// ─── Efficiency tracker ───────────────────────────────────────────────────────

export class EfficiencyTracker {
  private store: EventStore;
  private config: DuostackConfig;

  constructor(store: EventStore, config: DuostackConfig) {
    this.store = store;
    this.config = config;
  }

  // ─── Generate report ───────────────────────────────────────────────────────

  /**
   * Analyze the event log and generate an efficiency report.
   * Called periodically by the orchestrator, or on-demand via CLI.
   */
  async generateReport(): Promise<EfficiencyReport> {
    const events = await this.store.readAllEvents({ skipLeaseNoise: true });
    const now = new Date().toISOString();

    const byAgent = this.analyzeByAgent(events);
    const byTaskType = this.analyzeByTaskType(events);
    const wasteEvents = this.detectWaste(events);
    const recommendations = this.buildRecommendations(
      byAgent,
      byTaskType,
      wasteEvents
    );

    const report: EfficiencyReport = {
      generatedAt: now,
      period: {
        fromEvent: 0,
        toEvent: events.length,
      },
      byAgent,
      byTaskType,
      wasteEvents,
      recommendations,
    };

    // Write to disk
    await this.writeReport(report);

    return report;
  }

  // ─── Analysis ──────────────────────────────────────────────────────────────

  private analyzeByAgent(
    events: Awaited<ReturnType<EventStore["readAllEvents"]>>
  ): Record<string, AgentEfficiency> {
    const result: Record<string, AgentEfficiency> = {
      claude: this.emptyAgentEfficiency("claude"),
      antigravity: this.emptyAgentEfficiency("antigravity"),
    };

    for (const event of events) {
      const actor = event.actor as string;
      if (actor !== "claude" && actor !== "antigravity") continue;
      const entry = result[actor];
      if (!entry) continue;

      switch (event.eventType) {
        case "TaskCompleted":
          entry.tasksCompleted++;
          break;
        case "TaskHandedOff":
          entry.handoffCount++;
          break;
        case "TaskBlocked":
          entry.blockCount++;
          break;
        case "TaskLeaseExpired":
          entry.leaseExpiryCount++;
          break;
      }
    }

    // Estimate orientation tokens — each orient call costs ~250 tokens
    const orientCalls = events.filter(
      (e) => e.eventType === "AgentStatusObserved"
    );
    for (const call of orientCalls) {
      const a = (call.actor as string);
      if (result[a]) {
        result[a]!.estimatedTokensOnOrientation += 250;
      }
    }

    // Handoff tokens — each handoff consumes ~500 tokens (write + read)
    const handoffs = events.filter((e) => e.eventType === "TaskHandedOff");
    for (const h of handoffs) {
      const from = h.eventType === "TaskHandedOff"
        ? (h.payload as { handoff: { fromAgent: string } }).handoff.fromAgent
        : null;
      if (from && result[from]) {
        result[from]!.estimatedTokensOnHandoffs += 500;
      }
    }

    return result;
  }

  private analyzeByTaskType(
    events: Awaited<ReturnType<EventStore["readAllEvents"]>>
  ): Record<string, TaskTypeEfficiency> {
    const result: Record<string, TaskTypeEfficiency> = {};

    // Build task metadata from TaskCreated events
    const taskMeta: Record<string, {
      type: string;
      primaryAgent: string;
      completedBy?: string;
      attempts: number;
      handoffs: number;
    }> = {};

    for (const event of events) {
      switch (event.eventType) {
        case "TaskCreated": {
          const p = event.payload;
          taskMeta[p.taskId] = {
            type: p.type,
            primaryAgent: p.primaryAgent,
            attempts: 0,
            handoffs: 0,
          };
          break;
        }
        case "TaskClaimed": {
          const meta = taskMeta[event.payload.taskId];
          if (meta) meta.attempts++;
          break;
        }
        case "TaskHandedOff": {
          const meta = taskMeta[event.payload.taskId];
          if (meta) meta.handoffs++;
          break;
        }
        case "TaskCompleted": {
          const meta = taskMeta[event.payload.taskId];
          if (meta) meta.completedBy = event.payload.completedBy;
          break;
        }
      }
    }

    // Aggregate by type
    for (const [, meta] of Object.entries(taskMeta)) {
      if (!result[meta.type]) {
        result[meta.type] = {
          type: meta.type,
          count: 0,
          completedByPrimary: 0,
          completedByFallback: 0,
          averageAttempts: 0,
          handoffRate: 0,
        };
      }
      const entry = result[meta.type]!;
      entry.count++;

      if (meta.completedBy) {
        if (meta.completedBy === meta.primaryAgent) {
          entry.completedByPrimary++;
        } else {
          entry.completedByFallback++;
        }
      }

      // Running averages
      entry.averageAttempts =
        (entry.averageAttempts * (entry.count - 1) + meta.attempts) /
        entry.count;
      entry.handoffRate =
        (entry.handoffRate * (entry.count - 1) + (meta.handoffs > 0 ? 1 : 0)) /
        entry.count;
    }

    return result;
  }

  private detectWaste(
    events: Awaited<ReturnType<EventStore["readAllEvents"]>>
  ): WasteEvent[] {
    const waste: WasteEvent[] = [];

    // Track step state per task
    const stepState: Record<string, {
      lastPlannedStepId: string | null;
      handoffCount: number;
      attemptCount: number;
    }> = {};

    let decisionsSinceCheckpoint = 0;

    for (const event of events) {
      const taskId = event.taskId;

      // Initialize step state
      if (taskId && !stepState[taskId]) {
        stepState[taskId] = {
          lastPlannedStepId: null,
          handoffCount: 0,
          attemptCount: 0,
        };
      }

      switch (event.eventType) {

        case "TaskStepStarted": {
          // Check if there was a preceding TaskStepPlanned
          const state = taskId ? stepState[taskId] : null;
          if (
            state &&
            event.payload.stepId !== state.lastPlannedStepId
          ) {
            waste.push({
              eventId: event.eventId,
              timestamp: event.timestamp,
              type: "missing_step_plan",
              taskId,
              description:
                `Step ${event.payload.stepId} started without a TaskStepPlanned event. ` +
                "Intent-before-action rule violated — fallback agents cannot safely resume.",
              impact: "high",
            });
          }
          break;
        }

        case "TaskStepPlanned": {
          const state = taskId ? stepState[taskId] : null;
          if (state) {
            state.lastPlannedStepId = event.payload.stepId;
          }
          break;
        }

        case "TaskClaimed": {
          const state = taskId ? stepState[taskId] : null;
          if (state) {
            state.attemptCount++;
            if (state.attemptCount > 3) {
              waste.push({
                eventId: event.eventId,
                timestamp: event.timestamp,
                type: "high_attempt_count",
                taskId,
                description:
                  `Task ${taskId} has been claimed ${state.attemptCount} times. ` +
                  "Steps may not be idempotent — check isIdempotent flag on step plans.",
                impact: "medium",
              });
            }
          }
          break;
        }

        case "TaskHandedOff": {
          const state = taskId ? stepState[taskId] : null;
          if (state) {
            state.handoffCount++;
            if (state.handoffCount > 2) {
              waste.push({
                eventId: event.eventId,
                timestamp: event.timestamp,
                type: "handoff_loop",
                taskId,
                description:
                  `Task ${taskId} has been handed off ${state.handoffCount} times. ` +
                  "This suggests a coordination breakdown — consider decomposing the task further.",
                impact: "high",
              });
            }
          }
          break;
        }

        case "DecisionRecorded": {
          decisionsSinceCheckpoint++;
          break;
        }

        case "ProjectCheckpointWritten": {
          if (decisionsSinceCheckpoint > 5) {
            waste.push({
              eventId: event.eventId,
              timestamp: event.timestamp,
              type: "checkpoint_skipped",
              taskId: null,
              description:
                `${decisionsSinceCheckpoint} decisions were recorded without a checkpoint. ` +
                "Context saturation during this window would have lost these decisions.",
              impact: "medium",
            });
          }
          decisionsSinceCheckpoint = 0;
          break;
        }
      }
    }

    return waste;
  }

  private buildRecommendations(
    byAgent: Record<string, AgentEfficiency>,
    byTaskType: Record<string, TaskTypeEfficiency>,
    wasteEvents: WasteEvent[]
  ): string[] {
    const recs: string[] = [];

    // Check for missing step plans
    const missingPlans = wasteEvents.filter(
      (w) => w.type === "missing_step_plan"
    );
    if (missingPlans.length > 0) {
      recs.push(
        `${missingPlans.length} steps started without intent plans. ` +
        "Always call ds_plan_step (Claude) or plan_step skill (Antigravity) before executing."
      );
    }

    // Check for handoff loops
    const loops = wasteEvents.filter((w) => w.type === "handoff_loop");
    if (loops.length > 0) {
      recs.push(
        `${loops.length} tasks entered handoff loops. ` +
        "Decompose tasks smaller — each task should be completable in one agent session."
      );
    }

    // Check for high fallback rates
    for (const [type, stats] of Object.entries(byTaskType)) {
      if (stats.count >= 3 && stats.handoffRate > 0.5) {
        recs.push(
          `${type} tasks have a ${Math.round(stats.handoffRate * 100)}% handoff rate. ` +
          "Consider adjusting lease duration or task decomposition for this type."
        );
      }
    }

    // Check for high Antigravity lease expiry
    const agEfficiency = byAgent["antigravity"];
    if (
      agEfficiency &&
      agEfficiency.leaseExpiryCount > 3
    ) {
      recs.push(
        `Antigravity has had ${agEfficiency.leaseExpiryCount} lease expirations. ` +
        "Consider increasing lease duration in duostack.config.json (leases.durationMinutes)."
      );
    }

    if (recs.length === 0) {
      recs.push("No significant waste patterns detected. System is running efficiently.");
    }

    return recs;
  }

  private emptyAgentEfficiency(agentId: string): AgentEfficiency {
    return {
      agentId,
      tasksCompleted: 0,
      tasksHandedOff: 0,
      averageStepsPerTask: 0,
      handoffCount: 0,
      blockCount: 0,
      leaseExpiryCount: 0,
      estimatedTokensOnOrientation: 0,
      estimatedTokensOnExecution: 0,
      estimatedTokensOnHandoffs: 0,
    };
  }

  private async writeReport(report: EfficiencyReport): Promise<void> {
    const logPath = this.config.efficiency.logPath;
    const dir = path.dirname(logPath);

    try {
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(
        logPath,
        JSON.stringify(report, null, 2),
        "utf-8"
      );
    } catch {
      // Non-fatal — efficiency tracking is best-effort
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createEfficiencyTracker(
  store: EventStore,
  config: DuostackConfig
): EfficiencyTracker {
  return new EfficiencyTracker(store, config);
}
