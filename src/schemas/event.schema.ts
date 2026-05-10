/**
 * event.schema.ts
 *
 * The contract for everything written to events.jsonl.
 *
 * Key design decisions:
 * - events.jsonl is the ONLY source of truth. All snapshots are derived from it.
 * - Every event is immutable once appended. Never edit events.jsonl.
 * - Agents never write events directly — they POST to the local API which
 *   validates against these types and appends atomically.
 * - correlation_id links related events (e.g. a TaskStepPlanned and its
 *   TaskStepCompleted, or all events in a handoff sequence).
 * - The actor field is always explicit — never inferred.
 *
 * Event granularity decisions:
 * - Step-level, not file-level. ArtifactsObserved batches file changes
 *   per step, not per file touch. This keeps the log useful not noisy.
 * - LeaseRenewed only when the expiry window actually moves. Heartbeats
 *   are in-memory only — not written to the log every 60 seconds.
 * - DecisionProposed vs DecisionRecorded: Antigravity can PROPOSE decisions
 *   in fallback planning mode but cannot RECORD them. Only Claude records.
 */

import type { AgentId } from "./agent.schema.js";
import type { TaskType, TaskPriority, HandoffPayload } from "./task.schema.js";

// ─── Base event ───────────────────────────────────────────────────────────────

export interface BaseEvent {
  eventId: string;         // uuid v4
  eventType: EventType;
  timestamp: string;       // ISO 8601
  actor: AgentId | "orchestrator" | "developer" | "system";
  taskId: string | null;   // null for project/agent-level events
  correlationId: string;   // groups related events (uuid v4)
  schemaVersion: "1.0";
}

// ─── All event types ──────────────────────────────────────────────────────────

export type EventType =
  // Project lifecycle
  | "ProjectInitialized"
  | "ProjectCheckpointWritten"
  | "MilestoneReached"

  // Strategic memory
  | "DecisionRecorded"       // Claude only — final architectural decisions
  | "DecisionProposed"       // Antigravity fallback — must be reconciled by Claude

  // Task management
  | "TaskCreated"
  | "TaskClaimed"
  | "TaskBlocked"
  | "TaskHandedOff"
  | "TaskCompleted"
  | "TaskFailed"
  | "TaskCancelled"
  | "TaskLeaseExpired"

  // Step lifecycle (atomic unit of work)
  | "TaskStepPlanned"        // intent written BEFORE execution
  | "TaskStepStarted"        // execution begins
  | "TaskStepCompleted"      // result written AFTER execution
  | "TaskStepFailed"         // validation failed

  // Observability
  | "ArtifactsObserved"      // batched file changes per step
  | "ValidationRun"          // result of running a validation command

  // Lease / liveness
  | "LeaseRenewed"           // only written when expiry window actually moves
  | "LeaseExpired"           // written by orchestrator on detection

  // Agent availability
  | "AgentStatusObserved"
  | "AgentUnavailableObserved"
  | "AgentRecovered"
  | "AgentHealthUpdated"
  | "ManualOverrideSet";

// ─── Event payload types ──────────────────────────────────────────────────────

// Project lifecycle

export interface ProjectInitializedPayload {
  projectName: string;
  projectPath: string;
  goal: string;
  techStack: string[];
  stacklitVersion: string;   // pinned version used at init
  duostackVersion: string;
}

export interface ProjectCheckpointWrittenPayload {
  triggeredBy: "context_pressure" | "milestone" | "scheduled" | "manual";
  currentMilestone: string;
  openTaskCount: number;
  completedTaskCount: number;
  activeAgent: AgentId;
  summary: string;
}

export interface MilestoneReachedPayload {
  milestoneName: string;
  completedTaskIds: string[];
  nextMilestone: string | null;
}

// Strategic memory

export interface DecisionRecordedPayload {
  decisionId: string;        // e.g. "D-2026-04-12-001"
  title: string;
  decision: string;          // what was decided, one paragraph max
  rationale: string;         // why, one paragraph max
  constraints: string[];     // what this decision locks in
  status: "FINAL" | "PROVISIONAL";
  doNotReEvaluate: boolean;  // if true, future sessions skip this
}

export interface DecisionProposedPayload {
  proposedBy: "antigravity";
  title: string;
  proposal: string;
  rationale: string;
  requiresClaudeApproval: true;  // always true — AG cannot finalize arch decisions
  urgency: "blocking" | "normal";
}

// Task management

export interface TaskCreatedPayload {
  taskId: string;
  title: string;
  description: string;
  type: TaskType;
  priority: TaskPriority;
  primaryAgent: AgentId;
  fallbackAgent: AgentId;
  dependsOn: string[];
  acceptanceCriteria: string[];
}

export interface TaskClaimedPayload {
  taskId: string;
  claimedBy: AgentId;
  leaseExpiresAt: string;    // ISO 8601
  attemptNumber: number;
}

export interface TaskBlockedPayload {
  taskId: string;
  blockedBy: AgentId;
  reason: string;
  suggestedResolution: string | null;
}

export interface TaskHandedOffPayload {
  taskId: string;
  handoff: HandoffPayload;
}

export interface TaskCompletedPayload {
  taskId: string;
  completedBy: AgentId;
  summary: string;
  artifacts: string[];
  validationsPassed: string[];
}

export interface TaskFailedPayload {
  taskId: string;
  failedBy: AgentId;
  reason: string;
  lastStepId: string | null;
  willRetry: boolean;
}

export interface TaskCancelledPayload {
  taskId: string;
  cancelledBy: AgentId | "developer";
  reason: string;
}

export interface TaskLeaseExpiredPayload {
  taskId: string;
  wasClaimedBy: AgentId;
  expiredAt: string;         // ISO 8601
  handoffCount: number;
  willReassign: boolean;
}

// Step lifecycle

export interface TaskStepPlannedPayload {
  stepId: string;
  taskId: string;
  stepNumber: number;
  summary: string;
  targetFiles: string[];
  validation: string[];
  nextActionIfSuccess: string;
  nextActionIfFailure: string;
  isIdempotent: boolean;
  plannedBy: AgentId;
}

export interface TaskStepStartedPayload {
  stepId: string;
  taskId: string;
  startedBy: AgentId;
}

export interface TaskStepCompletedPayload {
  stepId: string;
  taskId: string;
  completedBy: AgentId;
  actualFilesChanged: string[];
  gitDiffHash: string | null;
  validationPassed: boolean;
  notes: string | null;
}

export interface TaskStepFailedPayload {
  stepId: string;
  taskId: string;
  failedBy: AgentId;
  validationOutput: string;
  takingFailurePath: string; // the nextActionIfFailure that was invoked
}

// Observability

export interface ArtifactsObservedPayload {
  stepId: string;
  taskId: string;
  filesChanged: string[];
  gitDiffHash: string | null;  // pointer to diff — fallback agent uses this for reconciliation
  observedBy: AgentId;
}

export interface ValidationRunPayload {
  stepId: string;
  taskId: string;
  command: string;
  passed: boolean;
  output: string;             // truncated to 500 chars max — not a log dump
  durationMs: number;
  runBy: AgentId;
}

// Lease / liveness

export interface LeaseRenewedPayload {
  taskId: string;
  renewedBy: AgentId;
  previousExpiresAt: string;  // ISO 8601
  newExpiresAt: string;       // ISO 8601 — only written when window actually moves
}

export interface LeaseExpiredPayload {
  taskId: string;
  wasHeldBy: AgentId;
  expiredAt: string;          // ISO 8601
  detectedBy: "orchestrator";
}

// Agent availability

export interface AgentStatusObservedPayload {
  agentId: AgentId;
  health: "normal" | "batching" | "triage" | "final_flush" | "exhausted" | "unknown";
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface AgentUnavailableObservedPayload {
  agentId: AgentId;
  reason:
    | "lease_expired_no_renewal"
    | "execution_failure"
    | "manual_override"
    | "repeated_failures";
  confidence: "high" | "medium" | "low";
  estimatedRecoveryAt: string | null;  // ISO 8601 — for weekly AG resets
  failoverActivated: boolean;
  failoverTo: AgentId | null;
}

export interface AgentRecoveredPayload {
  agentId: AgentId;
  recoveredAt: string;        // ISO 8601
  previousDowntime: string;   // human-readable, e.g. "6 days 4 hours"
  resumingFromCheckpoint: boolean;
  firstTaskId: string | null; // first task assigned after recovery
}

export interface AgentHealthUpdatedPayload {
  agentId: AgentId;
  previousHealth: string;
  newHealth: string;
  triggeredBy: "self_report" | "orchestrator_inference" | "manual";
}

export interface ManualOverrideSetPayload {
  agentId: AgentId;
  setBy: "developer";
  forcedStatus: "available" | "unavailable";
  reason: string;
  expiresAt: string | null;   // ISO 8601 — null = until manually cleared
}

// ─── Event union type ─────────────────────────────────────────────────────────

/**
 * A discriminated union of all possible events.
 * The API validates incoming payloads against this before appending.
 */
export type DuostackEvent =
  | (BaseEvent & { eventType: "ProjectInitialized";        payload: ProjectInitializedPayload })
  | (BaseEvent & { eventType: "ProjectCheckpointWritten";  payload: ProjectCheckpointWrittenPayload })
  | (BaseEvent & { eventType: "MilestoneReached";          payload: MilestoneReachedPayload })
  | (BaseEvent & { eventType: "DecisionRecorded";          payload: DecisionRecordedPayload })
  | (BaseEvent & { eventType: "DecisionProposed";          payload: DecisionProposedPayload })
  | (BaseEvent & { eventType: "TaskCreated";               payload: TaskCreatedPayload })
  | (BaseEvent & { eventType: "TaskClaimed";               payload: TaskClaimedPayload })
  | (BaseEvent & { eventType: "TaskBlocked";               payload: TaskBlockedPayload })
  | (BaseEvent & { eventType: "TaskHandedOff";             payload: TaskHandedOffPayload })
  | (BaseEvent & { eventType: "TaskCompleted";             payload: TaskCompletedPayload })
  | (BaseEvent & { eventType: "TaskFailed";                payload: TaskFailedPayload })
  | (BaseEvent & { eventType: "TaskCancelled";             payload: TaskCancelledPayload })
  | (BaseEvent & { eventType: "TaskLeaseExpired";          payload: TaskLeaseExpiredPayload })
  | (BaseEvent & { eventType: "TaskStepPlanned";           payload: TaskStepPlannedPayload })
  | (BaseEvent & { eventType: "TaskStepStarted";           payload: TaskStepStartedPayload })
  | (BaseEvent & { eventType: "TaskStepCompleted";         payload: TaskStepCompletedPayload })
  | (BaseEvent & { eventType: "TaskStepFailed";            payload: TaskStepFailedPayload })
  | (BaseEvent & { eventType: "ArtifactsObserved";         payload: ArtifactsObservedPayload })
  | (BaseEvent & { eventType: "ValidationRun";             payload: ValidationRunPayload })
  | (BaseEvent & { eventType: "LeaseRenewed";              payload: LeaseRenewedPayload })
  | (BaseEvent & { eventType: "LeaseExpired";              payload: LeaseExpiredPayload })
  | (BaseEvent & { eventType: "AgentStatusObserved";       payload: AgentStatusObservedPayload })
  | (BaseEvent & { eventType: "AgentUnavailableObserved";  payload: AgentUnavailableObservedPayload })
  | (BaseEvent & { eventType: "AgentRecovered";            payload: AgentRecoveredPayload })
  | (BaseEvent & { eventType: "AgentHealthUpdated";        payload: AgentHealthUpdatedPayload })
  | (BaseEvent & { eventType: "ManualOverrideSet";         payload: ManualOverrideSetPayload });

// ─── JSONL line ───────────────────────────────────────────────────────────────

/**
 * Each line in events.jsonl is a serialized DuostackEvent.
 * Lines are appended atomically — write to temp file, fsync, rename.
 * Never edit or delete lines. The log is append-only by contract.
 */
export type EventLogLine = DuostackEvent;

// ─── Helper: extract payload by event type ────────────────────────────────────

export type ExtractPayload<T extends EventType> = Extract<
  DuostackEvent,
  { eventType: T }
>["payload"];
