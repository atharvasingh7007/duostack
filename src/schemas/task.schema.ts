/**
 * task.schema.ts
 *
 * Defines the task lifecycle, step model, and state machine.
 *
 * Key design decisions:
 * - Tasks are broken into Steps. The step is the atomic unit of work —
 *   small enough to be safely re-run by a fallback agent (idempotent).
 * - Steps write intent BEFORE execution (TaskStepPlanned), then result
 *   AFTER (TaskStepCompleted). If the agent dies between these two events,
 *   the fallback agent has the intent and can reconcile against repo state.
 * - next_action_if_failure is explicit — the fallback agent should not
 *   reason about what to do on failure from scratch.
 * - Task ownership is lease-based. assigned_to alone is not enough.
 *   A lease must be valid (not expired) for ownership to be real.
 */

import type { AgentId } from "./agent.schema.js";

// ─── Task types ───────────────────────────────────────────────────────────────

/**
 * Determines primary and fallback agent assignment.
 *
 * plan / design / architecture / review / integrate → Claude primary
 * build / test / verify / browser                  → Antigravity primary
 * refactor / debug                                 → Both eligible
 */
export type TaskType =
  | "plan"
  | "design"
  | "architecture"
  | "review"
  | "integrate"
  | "build"
  | "test"
  | "verify"
  | "browser"
  | "refactor"
  | "debug";

// ─── Task priority ────────────────────────────────────────────────────────────

export type TaskPriority = "critical" | "high" | "normal" | "low";

// ─── Task state machine ───────────────────────────────────────────────────────

/**
 * Valid task states.
 *
 * Allowed transitions (enforced by API):
 *   pending         → claimed
 *   claimed         → in_progress
 *   claimed         → expired          (lease expired before work started)
 *   in_progress     → completed
 *   in_progress     → blocked
 *   in_progress     → failed
 *   blocked         → handoff_pending
 *   handoff_pending → claimed          (by fallback agent)
 *   expired         → pending          (returned to queue)
 *   failed          → pending          (retry)
 *   pending         → cancelled
 *
 * Terminal states: completed, cancelled
 */
export type TaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "handoff_pending"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

// ─── Step state machine ───────────────────────────────────────────────────────

/**
 * Valid step states within a task.
 *
 * planned     → intent written, not yet started
 * in_progress → agent working on it
 * completed   → validated successfully
 * failed      → validation failed, fallback path taken
 * skipped     → superseded by a later decision
 */
export type StepStatus =
  | "planned"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

// ─── Task step ────────────────────────────────────────────────────────────────

/**
 * The atomic unit of work. Small enough to be re-run safely.
 *
 * Written in two phases:
 * 1. TaskStepPlanned  → fills planned fields (intent before action)
 * 2. TaskStepCompleted → fills result fields (after action)
 *
 * If agent dies between 1 and 2, the fallback agent:
 *   - reads targetFiles to know what was being changed
 *   - runs git diff to see what actually changed
 *   - runs validation[] to check if it works
 *   - continues from nextActionIfSuccess or nextActionIfFailure
 */
export interface TaskStep {
  stepId: string;           // e.g. "step_001"
  taskId: string;
  stepNumber: number;       // 1-indexed within task

  // Intent (written BEFORE execution)
  summary: string;          // human-readable description of this step
  targetFiles: string[];    // files expected to be created/modified
  validation: string[];     // commands to run to verify success, e.g. ["pnpm test auth"]
  nextActionIfSuccess: string;  // what to do after this step succeeds
  nextActionIfFailure: string;  // explicit rollback/retry path
  isIdempotent: boolean;    // can this step be safely re-run?

  // Execution tracking
  status: StepStatus;
  startedAt: string | null;     // ISO 8601
  completedAt: string | null;   // ISO 8601
  executedBy: AgentId | null;

  // Result (written AFTER execution)
  result: {
    actualFilesChanged: string[];   // from ArtifactsObserved event
    gitDiffHash: string | null;     // pointer to exact diff for reconciliation
    validationPassed: boolean | null;
    validationOutput: string | null;
    notes: string | null;
  } | null;
}

// ─── Structured handoff payload ───────────────────────────────────────────────

/**
 * Written by the outgoing agent before or during final_flush.
 * This is what the fallback agent reads to resume without ambiguity.
 *
 * The key insight: the outgoing agent writes this BEFORE it runs out,
 * not when it's dying. Continuous checkpointing means this is always fresh.
 */
export interface HandoffPayload {
  fromAgent: AgentId;
  toAgent: AgentId;
  triggeredBy: "exhaustion" | "context_saturation" | "manual" | "lease_expired";
  handedOffAt: string; // ISO 8601

  // What was done
  summary: string;
  completedStepIds: string[];
  artifactsProduced: string[];

  // Exactly where to resume
  lastCompletedStepId: string | null;
  nextStepSummary: string;      // plain language — what the fallback should do first
  nextTargetFiles: string[];
  nextValidation: string[];

  // Context the fallback agent needs
  contextForFallback: string;   // e.g. "using ioredis client, schema in src/db/schema.ts:42"
  openQuestions: string[];      // things the outgoing agent was unsure about
  doNotTouch: string[];         // files/modules the fallback should avoid
}

// ─── Task ─────────────────────────────────────────────────────────────────────

export interface Task {
  taskId: string;             // e.g. "task_001"
  title: string;
  description: string;
  type: TaskType;
  priority: TaskPriority;

  // Ownership
  createdBy: AgentId | "developer";
  primaryAgent: AgentId;      // who should normally do this
  fallbackAgent: AgentId;     // who takes over if primary is down
  assignedTo: AgentId | null; // current assignment (null = unassigned)

  // Lease (null = not claimed)
  lease: {
    claimedBy: AgentId;
    claimedAt: string;        // ISO 8601
    expiresAt: string;        // ISO 8601
    lastRenewedAt: string;    // ISO 8601
    attemptNumber: number;
    handoffCount: number;
  } | null;

  // State
  status: TaskStatus;
  createdAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
  completedAt: string | null; // ISO 8601

  // Dependencies
  dependsOn: string[];        // taskIds that must complete first
  blocks: string[];           // taskIds that are waiting on this

  // Steps
  steps: TaskStep[];
  currentStepId: string | null;

  // Acceptance criteria (written by Claude during planning)
  acceptanceCriteria: string[];

  // Handoff (populated when task is handed off)
  handoff: HandoffPayload | null;

  // Block reason (populated when status = blocked)
  blockedReason: string | null;
}

// ─── Tasks snapshot ───────────────────────────────────────────────────────────

/**
 * tasks.snapshot.json — derived from events.jsonl.
 * The operational view agents read to understand current work state.
 */
export interface TasksSnapshot {
  generatedAt: string;       // ISO 8601
  eventLogVersion: number;   // event count at time of generation
  tasks: Record<string, Task>;

  // Convenience indexes (derived, not source of truth)
  byStatus: Record<TaskStatus, string[]>;  // status → taskIds
  byAgent: Record<AgentId, string[]>;       // agentId → taskIds
  criticalPath: string[];                   // taskIds on critical path
}

// ─── Task type routing table ──────────────────────────────────────────────────

/**
 * Defines which agent is primary and fallback for each task type.
 * Also specifies efficiency scores — used to decide whether fallback
 * should take a task (only if it's blocking something, or nothing else available).
 */
export const TASK_ROUTING: Record<
  TaskType,
  {
    primary: AgentId;
    fallback: AgentId;
    claudeEfficiency: number;       // 0-1
    antigravityEfficiency: number;  // 0-1
    fallbackOnlyIfBlocking: boolean;
  }
> = {
  plan:         { primary: "claude",       fallback: "antigravity", claudeEfficiency: 0.95, antigravityEfficiency: 0.55, fallbackOnlyIfBlocking: false },
  design:       { primary: "claude",       fallback: "antigravity", claudeEfficiency: 0.95, antigravityEfficiency: 0.50, fallbackOnlyIfBlocking: false },
  architecture: { primary: "claude",       fallback: "antigravity", claudeEfficiency: 0.98, antigravityEfficiency: 0.40, fallbackOnlyIfBlocking: true  },
  review:       { primary: "claude",       fallback: "antigravity", claudeEfficiency: 0.90, antigravityEfficiency: 0.60, fallbackOnlyIfBlocking: false },
  integrate:    { primary: "claude",       fallback: "antigravity", claudeEfficiency: 0.88, antigravityEfficiency: 0.50, fallbackOnlyIfBlocking: true  },
  build:        { primary: "antigravity",  fallback: "claude",      claudeEfficiency: 0.60, antigravityEfficiency: 0.95, fallbackOnlyIfBlocking: false },
  test:         { primary: "antigravity",  fallback: "claude",      claudeEfficiency: 0.65, antigravityEfficiency: 0.98, fallbackOnlyIfBlocking: false },
  verify:       { primary: "antigravity",  fallback: "claude",      claudeEfficiency: 0.60, antigravityEfficiency: 0.95, fallbackOnlyIfBlocking: false },
  browser:      { primary: "antigravity",  fallback: "claude",      claudeEfficiency: 0.40, antigravityEfficiency: 0.98, fallbackOnlyIfBlocking: true  },
  refactor:     { primary: "antigravity",  fallback: "claude",      claudeEfficiency: 0.75, antigravityEfficiency: 0.80, fallbackOnlyIfBlocking: false },
  debug:        { primary: "claude",       fallback: "antigravity", claudeEfficiency: 0.85, antigravityEfficiency: 0.75, fallbackOnlyIfBlocking: false },
};

// ─── Valid state transitions ──────────────────────────────────────────────────

export const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:         ["claimed", "cancelled"],
  claimed:         ["in_progress", "expired"],
  in_progress:     ["completed", "blocked", "failed"],
  blocked:         ["handoff_pending", "cancelled"],
  handoff_pending: ["claimed"],
  completed:       [],
  failed:          ["pending"],
  expired:         ["pending"],
  cancelled:       [],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}
