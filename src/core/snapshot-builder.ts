/**
 * snapshot-builder.ts
 *
 * Derives tasks.snapshot.json, agents.snapshot.json, and project.snapshot.json
 * by replaying events.jsonl from the beginning.
 *
 * Key design decisions:
 * - Snapshots are NEVER edited directly. They are always rebuilt from events.
 *   This means snapshot state is always consistent with the event log.
 * - Rebuilds are full replays, not incremental patches. For v1 this is fine —
 *   event logs for a single project will rarely exceed a few thousand events.
 *   If performance becomes an issue, add a checkpoint snapshot + replay-from-N.
 * - Snapshots are written atomically (temp file → rename) to prevent
 *   agents reading a half-written snapshot.
 * - The snapshot includes eventLogVersion so agents can detect staleness.
 *   If snapshot.eventLogVersion < store.version, rebuild before reading.
 * - Writes are triggered by the orchestrator after each append, not by agents.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { EventStore } from "./event-store.js";
import type { DuostackEvent } from "../schemas/event.schema.js";
import type {
  Task,
  TaskStep,
  TasksSnapshot,
  TaskStatus,
  HandoffPayload,
} from "../schemas/task.schema.js";
import {
  isValidTransition,
  TASK_ROUTING,
} from "../schemas/task.schema.js";
import type {
  AgentSnapshot,
  AgentsSnapshot,
  AgentId,
  TaskLease,
} from "../schemas/agent.schema.js";

// ─── Project snapshot ─────────────────────────────────────────────────────────

export interface ProjectSnapshot {
  generatedAt: string;
  eventLogVersion: number;
  projectName: string;
  projectPath: string;
  goal: string;
  techStack: string[];
  currentMilestone: string | null;
  completedMilestones: string[];
  openTaskCount: number;
  completedTaskCount: number;
  blockedTaskCount: number;
  activeAgents: AgentId[];
  lastCheckpointAt: string | null;
  stacklitVersion: string | null;
  duostackVersion: string | null;
}

// ─── Snapshot builder class ───────────────────────────────────────────────────

export class SnapshotBuilder {
  private stateDir: string;
  private store: EventStore;

  constructor(stateDir: string, store: EventStore) {
    this.stateDir = stateDir;
    this.store = store;
  }

  // ─── Main rebuild ──────────────────────────────────────────────────────────

  /**
   * Full rebuild of all three snapshots from the event log.
   * Called by orchestrator after each event append.
   */
  async rebuildAll(): Promise<{
    tasks: TasksSnapshot;
    agents: AgentsSnapshot;
    project: ProjectSnapshot;
  }> {
    const events = await this.store.readAllEvents();
    const version = this.store.version;
    const now = new Date().toISOString();

    // Replay all events into working state
    const state = this.replayEvents(events, version, now);

    // Write all three snapshots atomically
    await Promise.all([
      this.writeSnapshot("tasks.snapshot.json", state.tasks),
      this.writeSnapshot("agents.snapshot.json", state.agents),
      this.writeSnapshot("project.snapshot.json", state.project),
    ]);

    return state;
  }

  /**
   * Read current snapshots from disk without rebuilding.
   * Used by agents and the API for fast reads.
   */
  async readSnapshot<T>(filename: string): Promise<T | null> {
    const filePath = path.join(this.stateDir, filename);
    try {
      const content = await fsPromises.readFile(filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  async readTasksSnapshot(): Promise<TasksSnapshot | null> {
    return this.readSnapshot<TasksSnapshot>("tasks.snapshot.json");
  }

  async readAgentsSnapshot(): Promise<AgentsSnapshot | null> {
    return this.readSnapshot<AgentsSnapshot>("agents.snapshot.json");
  }

  async readProjectSnapshot(): Promise<ProjectSnapshot | null> {
    return this.readSnapshot<ProjectSnapshot>("project.snapshot.json");
  }

  /**
   * Check if snapshots are stale (event log has newer events).
   */
  async isStale(): Promise<boolean> {
    const tasks = await this.readTasksSnapshot();
    if (!tasks) return true;
    return tasks.eventLogVersion < this.store.version;
  }

  // ─── Event replay ──────────────────────────────────────────────────────────

  /**
   * Replay all events in order to build current state.
   * This is a pure function — same events always produce same state.
   */
  private replayEvents(
    events: DuostackEvent[],
    version: number,
    now: string
  ): {
    tasks: TasksSnapshot;
    agents: AgentsSnapshot;
    project: ProjectSnapshot;
  } {
    // Working state
    const tasks: Record<string, Task> = {};
    const agents: Record<AgentId, AgentSnapshot> = {
      claude: this.defaultAgentSnapshot("claude", now),
      antigravity: this.defaultAgentSnapshot("antigravity", now),
    };

    let project: ProjectSnapshot = {
      generatedAt: now,
      eventLogVersion: version,
      projectName: "",
      projectPath: "",
      goal: "",
      techStack: [],
      currentMilestone: null,
      completedMilestones: [],
      openTaskCount: 0,
      completedTaskCount: 0,
      blockedTaskCount: 0,
      activeAgents: [],
      lastCheckpointAt: null,
      stacklitVersion: null,
      duostackVersion: null,
    };

    // Replay each event
    for (const event of events) {
      this.applyEvent(event, tasks, agents, project);
    }

    // Build derived indexes for tasks snapshot
    const byStatus = this.buildStatusIndex(tasks);
    const byAgent = this.buildAgentIndex(tasks);
    const criticalPath = this.identifyCriticalPath(tasks);

    // Update project counts
    project.openTaskCount = Object.values(tasks).filter(
      (t) => !["completed", "cancelled"].includes(t.status)
    ).length;
    project.completedTaskCount = Object.values(tasks).filter(
      (t) => t.status === "completed"
    ).length;
    project.blockedTaskCount = Object.values(tasks).filter(
      (t) => t.status === "blocked"
    ).length;
    project.activeAgents = (["claude", "antigravity"] as AgentId[]).filter(
      (id) => agents[id]?.status === "available"
    );

    return {
      tasks: {
        generatedAt: now,
        eventLogVersion: version,
        tasks,
        byStatus,
        byAgent,
        criticalPath,
      },
      agents: {
        generatedAt: now,
        eventLogVersion: version,
        agents: agents as Record<AgentId, AgentSnapshot>,
      },
      project,
    };
  }

  /**
   * Apply a single event to the working state.
   * Each event type mutates state in a specific, deterministic way.
   */
  private applyEvent(
    event: DuostackEvent,
    tasks: Record<string, Task>,
    agents: Record<AgentId, AgentSnapshot>,
    project: ProjectSnapshot
  ): void {
    const now = event.timestamp;

    switch (event.eventType) {

      // ── Project lifecycle ──────────────────────────────────────────────────

      case "ProjectInitialized": {
        const p = event.payload;
        project.projectName = p.projectName;
        project.projectPath = p.projectPath;
        project.goal = p.goal;
        project.techStack = p.techStack;
        project.stacklitVersion = p.stacklitVersion;
        project.duostackVersion = p.duostackVersion;
        break;
      }

      case "ProjectCheckpointWritten": {
        project.lastCheckpointAt = now;
        project.currentMilestone = event.payload.currentMilestone;
        break;
      }

      case "MilestoneReached": {
        project.completedMilestones.push(event.payload.milestoneName);
        project.currentMilestone = event.payload.nextMilestone;
        break;
      }

      // ── Task management ────────────────────────────────────────────────────

      case "TaskCreated": {
        const p = event.payload;
        const routing = TASK_ROUTING[p.type];
        tasks[p.taskId] = {
          taskId: p.taskId,
          title: p.title,
          description: p.description,
          type: p.type,
          priority: p.priority,
          createdBy: event.actor as AgentId | "developer",
          primaryAgent: p.primaryAgent,
          fallbackAgent: p.fallbackAgent,
          assignedTo: null,
          lease: null,
          status: "pending",
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          dependsOn: p.dependsOn,
          blocks: [],
          steps: [],
          currentStepId: null,
          acceptanceCriteria: p.acceptanceCriteria,
          handoff: null,
          blockedReason: null,
        };

        // Update blocks index
        for (const depId of p.dependsOn) {
          if (tasks[depId]) {
            tasks[depId]!.blocks.push(p.taskId);
          }
        }

        // Suppress unused variable warning
        void routing;
        break;
      }

      case "TaskClaimed": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;
        if (!isValidTransition(task.status, "claimed")) break;

        task.status = "claimed";
        task.assignedTo = p.claimedBy;
        task.lease = {
          claimedBy: p.claimedBy,
          claimedAt: now,
          expiresAt: p.leaseExpiresAt,
          lastRenewedAt: now,
          attemptNumber: p.attemptNumber,
          handoffCount: task.lease?.handoffCount ?? 0,
        };
        task.updatedAt = now;

        // Update agent active lease
        const agent = agents[p.claimedBy];
        if (agent) {
          const lease: TaskLease = {
            taskId: p.taskId,
            agentId: p.claimedBy,
            claimedAt: now,
            expiresAt: p.leaseExpiresAt,
            lastRenewedAt: now,
            attemptNumber: p.attemptNumber,
            handoffCount: 0,
          };
          agent.activeLease = lease;
        }
        break;
      }

      case "TaskBlocked": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;
        if (!isValidTransition(task.status, "blocked")) break;

        task.status = "blocked";
        task.blockedReason = p.reason;
        task.updatedAt = now;
        break;
      }

      case "TaskHandedOff": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;

        task.handoff = p.handoff;
        task.status = "handoff_pending";
        task.updatedAt = now;

        if (task.lease) {
          task.lease.handoffCount++;
        }
        break;
      }

      case "TaskCompleted": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;
        if (!isValidTransition(task.status, "completed")) break;

        task.status = "completed";
        task.lease = null;
        task.completedAt = now;
        task.updatedAt = now;

        // Clear agent active lease if it was this task
        const completingAgent = agents[p.completedBy];
        if (completingAgent?.activeLease?.taskId === p.taskId) {
          completingAgent.activeLease = null;
        }
        break;
      }

      case "TaskFailed": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;
        if (!isValidTransition(task.status, "failed")) break;

        task.status = p.willRetry ? "pending" : "failed";
        task.lease = null;
        task.updatedAt = now;
        break;
      }

      case "TaskCancelled": {
        const task = tasks[event.payload.taskId];
        if (!task) break;
        task.status = "cancelled";
        task.lease = null;
        task.updatedAt = now;
        break;
      }

      case "TaskLeaseExpired": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;

        if (p.willReassign) {
          task.status = "pending";
        } else {
          task.status = "expired";
        }
        task.lease = null;
        task.updatedAt = now;

        // Clear agent active lease
        const wasAgent = agents[p.wasClaimedBy];
        if (wasAgent?.activeLease?.taskId === p.taskId) {
          wasAgent.activeLease = null;
        }
        break;
      }

      // ── Step lifecycle ─────────────────────────────────────────────────────

      case "TaskStepPlanned": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;

        const step: TaskStep = {
          stepId: p.stepId,
          taskId: p.taskId,
          stepNumber: p.stepNumber,
          summary: p.summary,
          targetFiles: p.targetFiles,
          validation: p.validation,
          nextActionIfSuccess: p.nextActionIfSuccess,
          nextActionIfFailure: p.nextActionIfFailure,
          isIdempotent: p.isIdempotent,
          status: "planned",
          startedAt: null,
          completedAt: null,
          executedBy: null,
          result: null,
        };

        task.steps.push(step);
        task.status = "in_progress";
        task.updatedAt = now;
        break;
      }

      case "TaskStepStarted": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;

        const step = task.steps.find((s) => s.stepId === p.stepId);
        if (!step) break;

        step.status = "in_progress";
        step.startedAt = now;
        step.executedBy = p.startedBy;
        task.currentStepId = p.stepId;
        task.updatedAt = now;
        break;
      }

      case "TaskStepCompleted": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;

        const step = task.steps.find((s) => s.stepId === p.stepId);
        if (!step) break;

        step.status = "completed";
        step.completedAt = now;
        step.result = {
          actualFilesChanged: p.actualFilesChanged,
          gitDiffHash: p.gitDiffHash,
          validationPassed: p.validationPassed,
          validationOutput: null,
          notes: p.notes,
        };
        task.currentStepId = null;
        task.updatedAt = now;
        break;
      }

      case "TaskStepFailed": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task) break;

        const step = task.steps.find((s) => s.stepId === p.stepId);
        if (!step) break;

        step.status = "failed";
        task.updatedAt = now;
        break;
      }

      // ── Lease ──────────────────────────────────────────────────────────────

      case "LeaseRenewed": {
        const p = event.payload;
        const task = tasks[p.taskId];
        if (!task?.lease) break;

        task.lease.expiresAt = p.newExpiresAt;
        task.lease.lastRenewedAt = now;
        task.updatedAt = now;

        const agent = agents[p.renewedBy];
        if (agent?.activeLease?.taskId === p.taskId) {
          agent.activeLease.expiresAt = p.newExpiresAt;
          agent.activeLease.lastRenewedAt = now;
        }
        break;
      }

      // ── Agent availability ─────────────────────────────────────────────────

      case "AgentStatusObserved": {
        const p = event.payload;
        const agent = agents[p.agentId];
        if (!agent) break;

        agent.health = p.health;
        agent.lastObservedAt = now;
        if (p.health !== "unknown") { agent.tokenHealth.level = p.health; }
        agent.tokenHealth.lastUpdatedAt = now;
        break;
      }

      case "AgentUnavailableObserved": {
        const p = event.payload;
        const agent = agents[p.agentId];
        if (!agent) break;

        agent.status = "unavailable";
        agent.health = "exhausted";
        agent.confidence = p.confidence;
        agent.lastFailureReason = p.reason;
        agent.lastObservedAt = now;
        agent.tokenHealth.level = "exhausted";
        agent.tokenHealth.estimatedResetAt = p.estimatedRecoveryAt;
        agent.tokenHealth.lastUpdatedAt = now;
        agent.activeLease = null;
        break;
      }

      case "AgentRecovered": {
        const p = event.payload;
        const agent = agents[p.agentId];
        if (!agent) break;

        agent.status = "available";
        agent.health = "normal";
        agent.isInFallbackMode = false;
        agent.lastObservedAt = now;
        agent.lastSuccessfulActionAt = now;
        agent.lastFailureReason = null;
        agent.tokenHealth.level = "normal";
        agent.tokenHealth.estimatedResetAt = null;
        agent.tokenHealth.lastUpdatedAt = now;
        break;
      }

      case "AgentHealthUpdated": {
        const p = event.payload;
        const agent = agents[p.agentId];
        if (!agent) break;

        agent.health = p.newHealth as AgentSnapshot["health"];
        const validLevels = ["normal","batching","triage","final_flush","exhausted"] as const;
        if ((validLevels as readonly string[]).includes(p.newHealth)) {
          agent.tokenHealth.level = p.newHealth as typeof validLevels[number];
        };
        agent.tokenHealth.lastUpdatedAt = now;
        agent.lastObservedAt = now;
        break;
      }

      case "ManualOverrideSet": {
        const p = event.payload;
        const agent = agents[p.agentId];
        if (!agent) break;

        agent.manualOverride = {
          active: true,
          forcedStatus: p.forcedStatus,
          setAt: now,
          reason: p.reason,
        };

        if (p.forcedStatus === "unavailable") {
          agent.status = "unavailable";
        } else {
          agent.status = "available";
        }
        break;
      }

      // Events that don't affect snapshot state (observability only)
      case "DecisionRecorded":
      case "DecisionProposed":
      case "ArtifactsObserved":
      case "ValidationRun":
      case "LeaseExpired":
        break;
    }
  }

  // ─── Derived indexes ───────────────────────────────────────────────────────

  private buildStatusIndex(
    tasks: Record<string, Task>
  ): Record<TaskStatus, string[]> {
    const index: Record<TaskStatus, string[]> = {
      pending: [],
      claimed: [],
      in_progress: [],
      blocked: [],
      handoff_pending: [],
      completed: [],
      failed: [],
      expired: [],
      cancelled: [],
    };

    for (const task of Object.values(tasks)) {
      index[task.status].push(task.taskId);
    }

    return index;
  }

  private buildAgentIndex(
    tasks: Record<string, Task>
  ): Record<AgentId, string[]> {
    const index: Record<AgentId, string[]> = {
      claude: [],
      antigravity: [],
    };

    for (const task of Object.values(tasks)) {
      if (task.assignedTo) {
        index[task.assignedTo]?.push(task.taskId);
      }
    }

    return index;
  }

  /**
   * Identify the critical path — tasks that are blocking other tasks.
   * Simple implementation: tasks with the most dependents come first.
   */
  private identifyCriticalPath(tasks: Record<string, Task>): string[] {
    return Object.values(tasks)
      .filter((t) => t.blocks.length > 0 && t.status !== "completed")
      .sort((a, b) => b.blocks.length - a.blocks.length)
      .map((t) => t.taskId);
  }

  // ─── Default agent snapshot ────────────────────────────────────────────────

  private defaultAgentSnapshot(agentId: AgentId, now: string): AgentSnapshot {
    return {
      agentId,
      health: "unknown",
      status: "available",
      confidence: "low",
      lastObservedAt: now,
      lastSuccessfulActionAt: null,
      lastFailureReason: null,
      currentRole: agentId === "claude" ? "planner" : "executor",
      isInFallbackMode: false,
      activeLease: null,
      manualOverride: {
        active: false,
        forcedStatus: null,
        setAt: null,
        reason: null,
      },
      tokenHealth: {
        level: "normal",
        estimatedResetAt: null,
        lastUpdatedAt: now,
      },
    };
  }

  // ─── Atomic snapshot write ─────────────────────────────────────────────────

  /**
   * Write a snapshot file atomically.
   * Write to .tmp → fsync → rename to final path.
   * Agents reading the snapshot never see a partial write.
   */
  private async writeSnapshot(filename: string, data: unknown): Promise<void> {
    const finalPath = path.join(this.stateDir, filename);
    const tmpPath = finalPath + ".tmp";

    const content = JSON.stringify(data, null, 2);

    await fsPromises.writeFile(tmpPath, content, "utf-8");

    // fsync the tmp file
    const fd = await fsPromises.open(tmpPath, "r+");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }

    // Atomic rename (works on Unix; on Windows falls back to copy+delete)
    try {
      await fsPromises.rename(tmpPath, finalPath);
    } catch {
      // Windows fallback
      await fsPromises.copyFile(tmpPath, finalPath);
      await fsPromises.unlink(tmpPath).catch(() => {});
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSnapshotBuilder(
  stateDir: string,
  store: EventStore
): SnapshotBuilder {
  return new SnapshotBuilder(stateDir, store);
}
