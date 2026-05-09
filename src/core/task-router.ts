/**
 * task-router.ts
 *
 * Decides which agent should handle each task based on:
 * - Task type (primary vs fallback routing table)
 * - Agent health and token level
 * - Task priority and blocking status
 * - Efficiency scores (don't assign a 0.4 efficiency fallback unless blocking)
 *
 * Key design decisions:
 * - Routing is deterministic given the same snapshot state. Same inputs
 *   always produce the same decision. No randomness.
 * - Token health changes routing behavior BEFORE exhaustion hits.
 *   At "triage" level, only critical-path tasks are assigned.
 *   At "batching" level, tasks are grouped before assignment.
 * - The router never writes events. It only reads snapshots and returns
 *   decisions. The orchestrator acts on those decisions and writes events.
 * - Stacklit-aware: the router can signal that an agent should read the
 *   Stacklit derive map (250 tokens) vs full index (4k tokens) based on
 *   token health before starting work.
 */

import type { SnapshotBuilder } from "./snapshot-builder.js";
import type { AgentsSnapshot, AgentId, AgentSnapshot } from "../schemas/agent.schema.js";
import type { Task, TasksSnapshot } from "../schemas/task.schema.js";
import { TASK_ROUTING } from "../schemas/task.schema.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RoutingResult {
  taskId: string;
  assignTo: AgentId;
  reason: RoutingReason;
  isInFallbackMode: boolean;
  stacklitReadMode: StacklitReadMode;
  priority: "critical" | "high" | "normal" | "low";
  shouldBatch: boolean; // true = group with other tasks before starting
}

export type RoutingReason =
  | "primary_available"
  | "primary_in_triage_defer_non_critical"
  | "fallback_primary_exhausted"
  | "fallback_primary_triage_critical_only"
  | "fallback_manual_override"
  | "blocked_both_unavailable"
  | "blocked_fallback_not_eligible";

/**
 * Which Stacklit read the assigned agent should perform before starting.
 * Adapts to token health — don't burn 4k tokens on orientation when
 * you only have 15% left.
 */
export type StacklitReadMode =
  | "full_index"    // healthy session — read full stacklit.json (~4k tokens)
  | "derive_map"    // medium pressure — read stacklit derive (~250 tokens)
  | "skip"          // final flush — skip unless touching unfamiliar module
  | "mcp_query";    // healthy + known module — live query via MCP tool

export interface BatchGroup {
  agentId: AgentId;
  taskIds: string[];
  reason: "token_pressure_batching";
}

// ─── Task router ──────────────────────────────────────────────────────────────

export class TaskRouter {
  private snapshots: SnapshotBuilder;

  constructor(snapshots: SnapshotBuilder) {
    this.snapshots = snapshots;
  }

  // ─── Route a single task ───────────────────────────────────────────────────

  /**
   * Determine which agent should handle a specific task.
   * Returns null if the task cannot be assigned right now.
   */
  async routeTask(taskId: string): Promise<RoutingResult | null> {
    const [tasksSnapshot, agentsSnapshot] = await Promise.all([
      this.snapshots.readTasksSnapshot(),
      this.snapshots.readAgentsSnapshot(),
    ]);

    if (!tasksSnapshot || !agentsSnapshot) return null;

    const task = tasksSnapshot.tasks[taskId];
    if (!task) return null;

    // Can't route tasks that aren't pending
    if (task.status !== "pending") return null;

    // Check if dependencies are satisfied
    if (!this.dependenciesSatisfied(task, tasksSnapshot)) {
      return null; // waiting on upstream tasks
    }

    return this.computeRouting(task, agentsSnapshot);
  }

  // ─── Route all pending tasks ───────────────────────────────────────────────

  /**
   * Route all pending tasks in priority order.
   * Returns a list of routing decisions for the orchestrator to act on.
   * Tasks that can't be routed right now are omitted.
   */
  async routeAllPending(): Promise<RoutingResult[]> {
    const [tasksSnapshot, agentsSnapshot] = await Promise.all([
      this.snapshots.readTasksSnapshot(),
      this.snapshots.readAgentsSnapshot(),
    ]);

    if (!tasksSnapshot || !agentsSnapshot) return [];

    const pendingIds = tasksSnapshot.byStatus["pending"];
    const results: RoutingResult[] = [];

    // Sort by priority before routing
    const sorted = pendingIds
      .map((id) => tasksSnapshot.tasks[id])
      .filter((t): t is Task => t !== undefined)
      .filter((t) => this.dependenciesSatisfied(t, tasksSnapshot))
      .sort((a, b) => this.comparePriority(a, b, tasksSnapshot));

    for (const task of sorted) {
      const result = this.computeRouting(task, agentsSnapshot);
      if (result) results.push(result);
    }

    return results;
  }

  // ─── Batch detection ───────────────────────────────────────────────────────

  /**
   * Identify tasks that should be batched together.
   * When an agent is in "batching" token health mode, we group 3-5 tasks
   * and provide them all at once rather than one at a time.
   * This reduces per-task orientation overhead.
   */
  async detectBatchGroups(): Promise<BatchGroup[]> {
    const [tasksSnapshot, agentsSnapshot] = await Promise.all([
      this.snapshots.readTasksSnapshot(),
      this.snapshots.readAgentsSnapshot(),
    ]);

    if (!tasksSnapshot || !agentsSnapshot) return [];

    const groups: BatchGroup[] = [];

    for (const agentId of ["claude", "antigravity"] as AgentId[]) {
      const agent = agentsSnapshot.agents[agentId];
      if (!agent || agent.tokenHealth.level !== "batching") continue;

      // Find tasks routed to this agent that should batch
      const allRouted = await this.routeAllPending();
      const agentTasks = allRouted
        .filter((r) => r.assignTo === agentId && r.shouldBatch)
        .slice(0, 5) // max 5 per batch
        .map((r) => r.taskId);

      if (agentTasks.length >= 2) {
        groups.push({
          agentId,
          taskIds: agentTasks,
          reason: "token_pressure_batching",
        });
      }
    }

    return groups;
  }

  // ─── Core routing logic ────────────────────────────────────────────────────

  private computeRouting(
    task: Task,
    agentsSnapshot: AgentsSnapshot
  ): RoutingResult | null {
    const routing = TASK_ROUTING[task.type];
    const primaryAgent = agentsSnapshot.agents[routing.primary];
    const fallbackAgent = agentsSnapshot.agents[routing.fallback];

    // ── Case 1: Primary is healthy ──────────────────────────────────────────

    if (this.isAgentEligible(primaryAgent, task)) {
      const tokenHealth = primaryAgent?.tokenHealth.level ?? "normal";

      // Triage mode: only critical-path tasks
      if (tokenHealth === "triage" && task.priority !== "critical") {
        return {
          taskId: task.taskId,
          assignTo: routing.primary,
          reason: "primary_in_triage_defer_non_critical",
          isInFallbackMode: false,
          stacklitReadMode: this.stacklitMode(tokenHealth),
          priority: task.priority,
          shouldBatch: false,
        };
      }

      return {
        taskId: task.taskId,
        assignTo: routing.primary,
        reason: "primary_available",
        isInFallbackMode: false,
        stacklitReadMode: this.stacklitMode(tokenHealth),
        priority: task.priority,
        shouldBatch: tokenHealth === "batching",
      };
    }

    // ── Case 2: Primary is exhausted or unavailable ─────────────────────────

    if (!this.isAgentEligible(fallbackAgent, task)) {
      // Both unavailable
      return {
        taskId: task.taskId,
        assignTo: routing.primary, // preferred, but blocked
        reason: "blocked_both_unavailable",
        isInFallbackMode: false,
        stacklitReadMode: "skip",
        priority: task.priority,
        shouldBatch: false,
      };
    }

    // Check if fallback is eligible for this task type
    if (routing.fallbackOnlyIfBlocking && task.blocks.length === 0) {
      return {
        taskId: task.taskId,
        assignTo: routing.fallback,
        reason: "blocked_fallback_not_eligible",
        isInFallbackMode: true,
        stacklitReadMode: this.stacklitMode(
          fallbackAgent?.tokenHealth.level ?? "normal"
        ),
        priority: task.priority,
        shouldBatch: false,
      };
    }

    // Fallback takes over
    const fallbackTokenHealth = fallbackAgent?.tokenHealth.level ?? "normal";

    // Triage mode for fallback too
    if (fallbackTokenHealth === "triage" && task.priority !== "critical") {
      return null; // defer — both agents in triage, task is non-critical
    }

    return {
      taskId: task.taskId,
      assignTo: routing.fallback,
      reason: "fallback_primary_exhausted",
      isInFallbackMode: true,
      stacklitReadMode: this.stacklitMode(fallbackTokenHealth),
      priority: task.priority,
      shouldBatch: fallbackTokenHealth === "batching",
    };
  }

  // ─── Eligibility check ─────────────────────────────────────────────────────

  /**
   * Is an agent eligible to take work right now?
   * "final_flush" agents are not assigned new tasks — they're writing handoff state.
   * "exhausted" and "unavailable" agents cannot take work.
   */
  private isAgentEligible(
    agent: AgentSnapshot | undefined,
    _task: Task
  ): boolean {
    if (!agent) return false;
    if (agent.status === "unavailable") return false;
    if (agent.health === "exhausted") return false;
    if (agent.health === "final_flush") return false;

    // Manual override takes precedence
    if (
      agent.manualOverride.active &&
      agent.manualOverride.forcedStatus === "unavailable"
    ) {
      return false;
    }

    return true;
  }

  // ─── Stacklit read mode ────────────────────────────────────────────────────

  /**
   * Determine which Stacklit read mode to use based on token health.
   *
   * healthy  → full index or MCP query (cheapest per-query)
   * batching → derive map (250 tokens)
   * triage   → derive map (250 tokens)
   * final_flush → skip (preserve tokens for handoff payload)
   *
   * The "skip" case includes a note: if the agent is touching an
   * unfamiliar module, it should still do a derive read. This is
   * enforced in the Antigravity rules.md, not in code.
   */
  private stacklitMode(
    tokenHealth: AgentSnapshot["tokenHealth"]["level"]
  ): StacklitReadMode {
    switch (tokenHealth) {
      case "normal":
        return "mcp_query";
      case "batching":
        return "derive_map";
      case "triage":
        return "derive_map";
      case "final_flush":
        return "skip";
      case "exhausted":
        return "skip";
      default:
        return "full_index";
    }
  }

  // ─── Priority comparison ───────────────────────────────────────────────────

  /**
   * Sort tasks by priority, then by whether they're on the critical path.
   */
  private comparePriority(
    a: Task,
    b: Task,
    snapshot: TasksSnapshot
  ): number {
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    const aPriority = priorityOrder[a.priority];
    const bPriority = priorityOrder[b.priority];

    if (aPriority !== bPriority) return aPriority - bPriority;

    // Same priority — critical path tasks first
    const aOnCriticalPath = snapshot.criticalPath.includes(a.taskId);
    const bOnCriticalPath = snapshot.criticalPath.includes(b.taskId);

    if (aOnCriticalPath && !bOnCriticalPath) return -1;
    if (!aOnCriticalPath && bOnCriticalPath) return 1;

    // Same priority, same criticality — sort by number of blocked tasks
    return b.blocks.length - a.blocks.length;
  }

  // ─── Dependency check ──────────────────────────────────────────────────────

  private dependenciesSatisfied(
    task: Task,
    snapshot: TasksSnapshot
  ): boolean {
    for (const depId of task.dependsOn) {
      const dep = snapshot.tasks[depId];
      if (!dep || dep.status !== "completed") return false;
    }
    return true;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createTaskRouter(snapshots: SnapshotBuilder): TaskRouter {
  return new TaskRouter(snapshots);
}
