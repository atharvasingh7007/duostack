/**
 * agent.schema.ts
 *
 * Defines the availability and health model for both agents.
 *
 * Key design decisions:
 * - Status is OBSERVED, never assumed. No agent reports its own health
 *   reliably — the orchestrator infers it from lease heartbeats and failures.
 * - Heartbeats are task-scoped, not agent-global. This lets the orchestrator
 *   know whether one task stalled or the whole agent vanished.
 * - Token availability is intentionally coarse. Neither Claude nor Antigravity
 *   exposes a reliable token-remaining API. We use observed behavior instead.
 */

// ─── Agent identifiers ────────────────────────────────────────────────────────

export type AgentId = "claude" | "antigravity";

// ─── Agent health status ──────────────────────────────────────────────────────

/**
 * Coarse health states inferred from observed behavior.
 *
 * normal      → agent is active and responding
 * batching    → token pressure detected; agent is grouping work
 * triage      → critical-path tasks only
 * final_flush → agent is writing handoff state before going down
 * exhausted   → agent has hit its limit; unavailable
 * unknown     → no recent signal; orchestrator cannot determine state
 */
export type AgentHealth =
  | "normal"
  | "batching"
  | "triage"
  | "final_flush"
  | "exhausted"
  | "unknown";

// ─── Agent availability confidence ───────────────────────────────────────────

/**
 * How confident is the orchestrator in its availability assessment?
 * Used to decide whether to trigger failover immediately or wait.
 */
export type AvailabilityConfidence = "high" | "medium" | "low";

// ─── Agent role ───────────────────────────────────────────────────────────────

/**
 * Primary role vs fallback role.
 * Roles can swap during failover but always revert when the primary recovers.
 *
 * claude primary roles:    planner, architect, reviewer, integrator
 * antigravity primary:     builder, tester, executor, browser-verifier
 *
 * In fallback:
 * - Claude can execute (eligible tasks only)
 * - Antigravity can do tactical planning (short-horizon only, no arch changes)
 */
export type AgentRole =
  | "planner"
  | "executor"
  | "reviewer"
  | "integrator"
  | "tactical-planner"  // antigravity fallback only
  | "fallback-executor"; // claude fallback only

// ─── Task-level lease heartbeat ───────────────────────────────────────────────

/**
 * A heartbeat scoped to a specific task claim.
 * Written as a LeaseRenewed event (not a raw append) — only when the
 * lease window actually moves. This keeps the event log clean.
 *
 * The orchestrator uses this to distinguish:
 *   - agent alive but one task stalled (task-level failure)
 *   - whole agent gone (agent-level failure)
 */
export interface TaskLease {
  taskId: string;
  agentId: AgentId;
  claimedAt: string;       // ISO 8601
  expiresAt: string;       // ISO 8601 — extended on each LeaseRenewed event
  lastRenewedAt: string;   // ISO 8601 — when the window last moved
  attemptNumber: number;   // increments on each reassignment
  handoffCount: number;    // total times this task has changed agent
}

// ─── Agent snapshot entry ─────────────────────────────────────────────────────

/**
 * The derived snapshot state for a single agent.
 * Written to agents.snapshot.json by the snapshot builder.
 * Agents READ this — they never write it directly.
 */
export interface AgentSnapshot {
  agentId: AgentId;

  // Observed availability
  health: AgentHealth;
  status: "available" | "unavailable" | "recovering";
  confidence: AvailabilityConfidence;

  // What was last observed
  lastObservedAt: string;        // ISO 8601
  lastSuccessfulActionAt: string | null;
  lastFailureReason: string | null;

  // Current role assignment
  currentRole: AgentRole;
  isInFallbackMode: boolean;

  // Active lease (null if agent has no claimed task right now)
  activeLease: TaskLease | null;

  // Manual override — developer can force status via CLI
  manualOverride: {
    active: boolean;
    forcedStatus: "available" | "unavailable" | null;
    setAt: string | null;
    reason: string | null;
  };

  // Token health (coarse — inferred not measured)
  tokenHealth: {
    level: "normal" | "batching" | "triage" | "final_flush" | "exhausted";
    estimatedResetAt: string | null; // ISO 8601 — for weekly Antigravity resets
    lastUpdatedAt: string;
  };
}

// ─── Full agents snapshot ─────────────────────────────────────────────────────

/**
 * agents.snapshot.json — derived from events.jsonl by snapshot builder.
 * Contains both agents' current state.
 */
export interface AgentsSnapshot {
  generatedAt: string; // ISO 8601
  eventLogVersion: number; // event count at time of generation
  agents: Record<AgentId, AgentSnapshot>;
}

// ─── Routing decision ─────────────────────────────────────────────────────────

/**
 * Used by the task router to determine which agent should handle a task.
 * Encodes both the assignment and the reason, for auditability.
 */
export interface RoutingDecision {
  taskId: string;
  assignTo: AgentId;
  reason:
    | "primary_available"
    | "primary_exhausted_fallback"
    | "manual_override"
    | "lease_expired_reassign";
  fallbackActive: boolean;
  decidedAt: string; // ISO 8601
}
