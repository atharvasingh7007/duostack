/**
 * routes/events.ts
 *
 * POST /events — the primary write endpoint.
 *
 * Agents never describe file operations. They describe intent:
 *   "I planned a step"    → TaskStepPlanned
 *   "I completed a step"  → TaskStepCompleted
 *   "I need a handoff"    → triggers HandoffManager
 *
 * Validation rules:
 * - eventType must be a known type
 * - actor must be a valid AgentId or system actor
 * - payload must match the event type's schema
 * - task-scoped events must reference a real taskId (except TaskCreated)
 * - Antigravity cannot post DecisionRecorded (only DecisionProposed)
 * - Orchestrator-only events (LeaseExpired, AgentUnavailableObserved)
 *   are rejected from agent actors
 */

import { Router, type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { EventType } from "../../schemas/event.schema.js";
import type { AgentId } from "../../schemas/agent.schema.js";

// ─── Events that only the orchestrator can write ───────────────────────────────

const ORCHESTRATOR_ONLY_EVENTS: EventType[] = [
  "TaskLeaseExpired",
  "AgentUnavailableObserved",
  "AgentRecovered",
  "LeaseExpired",
];

// ─── Events Antigravity cannot write ──────────────────────────────────────────

const CLAUDE_ONLY_EVENTS: EventType[] = [
  "DecisionRecorded",
  "ProjectInitialized",
];

// ─── All valid event types ────────────────────────────────────────────────────

const VALID_EVENT_TYPES: Set<EventType> = new Set([
  "ProjectInitialized",
  "ProjectCheckpointWritten",
  "MilestoneReached",
  "DecisionRecorded",
  "DecisionProposed",
  "TaskCreated",
  "TaskClaimed",
  "TaskBlocked",
  "TaskHandedOff",
  "TaskCompleted",
  "TaskFailed",
  "TaskCancelled",
  "TaskLeaseExpired",
  "TaskStepPlanned",
  "TaskStepStarted",
  "TaskStepCompleted",
  "TaskStepFailed",
  "ArtifactsObserved",
  "ValidationRun",
  "LeaseRenewed",
  "LeaseExpired",
  "AgentStatusObserved",
  "AgentUnavailableObserved",
  "AgentRecovered",
  "AgentHealthUpdated",
  "ManualOverrideSet",
]);

const VALID_ACTORS = new Set([
  "claude",
  "antigravity",
  "orchestrator",
  "developer",
  "system",
]);

// ─── Router ───────────────────────────────────────────────────────────────────

export function eventsRouter(orchestrator: Orchestrator): Router {
  const router = Router();
  const store = orchestrator.getStore();
  const snapshots = orchestrator.getSnapshots();

  /**
   * POST /events
   * Append a single event to events.jsonl.
   *
   * Body: {
   *   eventType: string
   *   actor: string
   *   taskId?: string
   *   correlationId?: string
   *   payload: object
   * }
   *
   * Response: { event, eventLogVersion }
   */
  router.post("/", async (req: Request, res: Response) => {
    const { eventType, actor, taskId, correlationId, payload } = req.body as {
      eventType: unknown;
      actor: unknown;
      taskId?: unknown;
      correlationId?: unknown;
      payload: unknown;
    };

    // ── Validate eventType ───────────────────────────────────────────────────

    if (typeof eventType !== "string" || !VALID_EVENT_TYPES.has(eventType as EventType)) {
      res.status(400).json({
        error: "Invalid eventType",
        received: eventType,
        valid: [...VALID_EVENT_TYPES],
      });
      return;
    }

    // ── Validate actor ───────────────────────────────────────────────────────

    if (typeof actor !== "string" || !VALID_ACTORS.has(actor)) {
      res.status(400).json({
        error: "Invalid actor",
        received: actor,
        valid: [...VALID_ACTORS],
      });
      return;
    }

    // ── Enforce actor permissions ────────────────────────────────────────────

    if (ORCHESTRATOR_ONLY_EVENTS.includes(eventType as EventType) && actor !== "orchestrator") {
      res.status(403).json({
        error: `Event type '${eventType}' can only be written by the orchestrator`,
      });
      return;
    }

    if (CLAUDE_ONLY_EVENTS.includes(eventType as EventType) && actor === "antigravity") {
      res.status(403).json({
        error: `Event type '${eventType}' cannot be written by Antigravity. ` +
               `Use 'DecisionProposed' instead — Claude will review and record.`,
      });
      return;
    }

    // ── Validate payload ─────────────────────────────────────────────────────

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      res.status(400).json({ error: "payload must be a non-null object" });
      return;
    }

    // ── Validate taskId references (for task-scoped events) ──────────────────

    if (taskId !== undefined) {
      if (typeof taskId !== "string") {
        res.status(400).json({ error: "taskId must be a string" });
        return;
      }

      // TaskCreated is exempt — the task doesn't exist yet
      if (eventType !== "TaskCreated") {
        const tasksSnapshot = await snapshots.readTasksSnapshot();
        if (!tasksSnapshot?.tasks[taskId]) {
          res.status(404).json({
            error: `Task not found: ${taskId}`,
            hint: "Ensure the task was created before posting step/progress events",
          });
          return;
        }
      }
    }

    // ── Validate task-scoped events have a taskId ────────────────────────────

    const TASK_SCOPED: EventType[] = [
      "TaskClaimed", "TaskBlocked", "TaskHandedOff", "TaskCompleted",
      "TaskFailed", "TaskCancelled", "TaskLeaseExpired",
      "TaskStepPlanned", "TaskStepStarted", "TaskStepCompleted", "TaskStepFailed",
      "ArtifactsObserved", "ValidationRun", "LeaseRenewed",
    ];

    if (TASK_SCOPED.includes(eventType as EventType) && !taskId) {
      res.status(400).json({
        error: `Event type '${eventType}' requires a taskId`,
      });
      return;
    }

    // ── Append event ─────────────────────────────────────────────────────────

    try {
      const appendInput = {
        eventType: eventType as EventType,
        actor: actor as AgentId | "orchestrator" | "developer" | "system",
        correlationId: typeof correlationId === "string" ? correlationId : uuidv4(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: payload as any,
      };
      if (typeof taskId === "string") {
        Object.assign(appendInput, { taskId });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const event = await store.appendEvent(appendInput as any);

      // Rebuild snapshots after every append
      await snapshots.rebuildAll();

      res.status(201).json({
        event,
        eventLogVersion: store.version,
      });
    } catch (err) {
      console.error("[api/events] append error:", err);
      res.status(500).json({
        error: "Failed to append event",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /events/recent?n=20
   * Returns the last N events (excluding lease noise).
   * Used by agents to orient at session start.
   */
  router.get("/recent", async (req: Request, res: Response) => {
    const n = Math.min(parseInt(String(req.query["n"] ?? "20"), 10), 100);

    try {
      const events = await store.readLastEvents(n);
      res.json({
        events,
        count: events.length,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read events" });
    }
  });

  /**
   * GET /events/task/:taskId
   * Full event history for a specific task.
   * Used by fallback agent during takeover reconciliation.
   */
  router.get("/task/:taskId", async (req: Request, res: Response) => {
    const { taskId } = req.params;

    if (!taskId) {
      res.status(400).json({ error: "taskId required" });
      return;
    }

    try {
      const events = await store.readTaskHistory(taskId);
      res.json({
        taskId,
        events,
        count: events.length,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read task history" });
    }
  });

  /**
   * GET /events/stats
   * Event log statistics — size, count, staleness.
   */
  router.get("/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await store.getStats();
      const isStale = await snapshots.isStale();

      res.json({
        ...stats,
        snapshotsStale: isStale,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  return router;
}
