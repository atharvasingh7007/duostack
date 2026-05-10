/**
 * routes/tasks.ts
 *
 * Task lifecycle endpoints.
 * All mutations append events — never edit snapshots directly.
 *
 * Endpoints:
 *   GET  /tasks                    → list tasks (filterable)
 *   GET  /tasks/:id                → single task + full step history
 *   POST /tasks/:id/claim          → agent claims a task (creates lease)
 *   POST /tasks/:id/progress       → report step progress
 *   POST /tasks/:id/complete       → mark task done
 *   POST /tasks/:id/block          → mark task blocked
 *   POST /tasks/:id/handoff        → request handoff to other agent
 *   GET  /tasks/:id/reconcile      → get reconciliation instruction for takeover
 */

import { Router, type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { Orchestrator } from "../../core/orchestrator.js";
import { HandoffManager } from "../../core/handoff-manager.js";
import type { AgentId } from "../../schemas/agent.schema.js";
import type { TaskStatus } from "../../schemas/task.schema.js";
import { isValidTransition } from "../../schemas/task.schema.js";

export function tasksRouter(orchestrator: Orchestrator): Router {
  const router = Router();
  const store = orchestrator.getStore();
  const snapshots = orchestrator.getSnapshots();
  const handoffManager = orchestrator.getHandoffManager();

  // ─── GET /tasks ────────────────────────────────────────────────────────────

  /**
   * List tasks with optional filters.
   * Query params: status, agent, priority, limit
   *
   * This is what agents read to understand current work state.
   * Returns scoped view — not the full snapshot — to minimize token cost.
   */
  router.get("/", async (req: Request, res: Response) => {
    const { status, agent, priority, limit } = req.query;

    try {
      const tasksSnapshot = await snapshots.readTasksSnapshot();
      if (!tasksSnapshot) {
        res.json({ tasks: [], eventLogVersion: store.version });
        return;
      }

      let tasks = Object.values(tasksSnapshot.tasks);

      // Apply filters
      if (status) {
        tasks = tasks.filter((t) => t.status === status);
      }
      if (agent) {
        tasks = tasks.filter(
          (t) => t.assignedTo === agent || t.primaryAgent === agent
        );
      }
      if (priority) {
        tasks = tasks.filter((t) => t.priority === priority);
      }

      // Sort by priority
      const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
      tasks.sort(
        (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
      );

      // Limit
      const limitN = limit ? Math.min(parseInt(String(limit), 10), 100) : 50;
      const paginated = tasks.slice(0, limitN);

      res.json({
        tasks: paginated,
        total: tasks.length,
        returned: paginated.length,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read tasks" });
    }
  });

  // ─── GET /tasks/:id ────────────────────────────────────────────────────────

  router.get("/:id", async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      const tasksSnapshot = await snapshots.readTasksSnapshot();
      const task = tasksSnapshot?.tasks[id ?? ""];

      if (!task) {
        res.status(404).json({ error: `Task not found: ${id}` });
        return;
      }

      res.json({ task, eventLogVersion: store.version });
    } catch (err) {
      res.status(500).json({ error: "Failed to read task" });
    }
  });

  // ─── POST /tasks/:id/claim ─────────────────────────────────────────────────

  /**
   * Agent claims a task and starts a lease.
   *
   * Body: { agent: AgentId }
   *
   * Validates:
   * - Task exists and is in "pending" or "handoff_pending" state
   * - Agent is the correct primary or fallback for this task
   * - Agent is available (not exhausted)
   */
  router.post("/:id/claim", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { agent } = req.body as { agent: unknown };

    if (!id) { res.status(400).json({ error: "taskId required" }); return; }
    if (typeof agent !== "string") {
      res.status(400).json({ error: "agent must be a string (claude | antigravity)" });
      return;
    }

    const agentId = agent as AgentId;
    const correlationId = uuidv4();

    try {
      const [tasksSnapshot, agentsSnapshot] = await Promise.all([
        snapshots.readTasksSnapshot(),
        snapshots.readAgentsSnapshot(),
      ]);

      const task = tasksSnapshot?.tasks[id];
      if (!task) {
        res.status(404).json({ error: `Task not found: ${id}` });
        return;
      }

      // Validate state transition
      if (!isValidTransition(task.status, "claimed")) {
        res.status(409).json({
          error: `Cannot claim task in status '${task.status}'`,
          validFrom: ["pending", "handoff_pending"],
          currentStatus: task.status,
        });
        return;
      }

      // Validate agent availability
      const agentSnapshot = agentsSnapshot?.agents[agentId];
      if (agentSnapshot?.status === "unavailable") {
        res.status(409).json({
          error: `Agent '${agentId}' is currently unavailable`,
          health: agentSnapshot.health,
          estimatedRecovery: agentSnapshot.tokenHealth.estimatedResetAt,
        });
        return;
      }

      // Validate agent is eligible for this task type
      if (
        agentId !== task.primaryAgent &&
        agentId !== task.fallbackAgent
      ) {
        res.status(403).json({
          error: `Agent '${agentId}' is not eligible for task type '${task.type}'`,
          primaryAgent: task.primaryAgent,
          fallbackAgent: task.fallbackAgent,
        });
        return;
      }

      const leaseExpiresAt = HandoffManager.generateLeaseExpiry();
      const attemptNumber = (task.lease?.attemptNumber ?? 0) + 1;

      const event = await store.appendEvent({
        eventType: "TaskClaimed",
        actor: agentId,
        taskId: id,
        correlationId,
        payload: {
          taskId: id,
          claimedBy: agentId,
          leaseExpiresAt,
          attemptNumber,
        },
      });

      await snapshots.rebuildAll();

      res.status(200).json({
        task: (await snapshots.readTasksSnapshot())?.tasks[id],
        event,
        leaseExpiresAt,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to claim task" });
    }
  });

  // ─── POST /tasks/:id/progress ──────────────────────────────────────────────

  /**
   * Report step progress. Writes TaskStepPlanned + TaskStepStarted together.
   * This is the "intent before action" write — called before the agent
   * starts executing the step.
   *
   * Body: {
   *   agent: AgentId
   *   step: {
   *     stepId: string
   *     stepNumber: number
   *     summary: string
   *     targetFiles: string[]
   *     validation: string[]
   *     nextActionIfSuccess: string
   *     nextActionIfFailure: string
   *     isIdempotent: boolean
   *   }
   * }
   */
  router.post("/:id/progress", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { agent, step } = req.body as {
      agent: unknown;
      step: unknown;
    };

    if (!id) { res.status(400).json({ error: "taskId required" }); return; }
    if (typeof agent !== "string") {
      res.status(400).json({ error: "agent required" });
      return;
    }
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      res.status(400).json({ error: "step object required" });
      return;
    }

    const agentId = agent as AgentId;
    const s = step as Record<string, unknown>;
    const correlationId = uuidv4();

    // Validate required step fields
    const required = ["stepId", "stepNumber", "summary", "targetFiles",
      "validation", "nextActionIfSuccess", "nextActionIfFailure", "isIdempotent"];

    for (const field of required) {
      if (!(field in s)) {
        res.status(400).json({ error: `step.${field} is required` });
        return;
      }
    }

    try {
      // Write TaskStepPlanned + TaskStepStarted as an atomic pair
      const events = await store.appendEvents(
        [
          {
            eventType: "TaskStepPlanned",
            actor: agentId,
            taskId: id,
            payload: {
              stepId: s["stepId"] as string,
              taskId: id,
              stepNumber: s["stepNumber"] as number,
              summary: s["summary"] as string,
              targetFiles: s["targetFiles"] as string[],
              validation: s["validation"] as string[],
              nextActionIfSuccess: s["nextActionIfSuccess"] as string,
              nextActionIfFailure: s["nextActionIfFailure"] as string,
              isIdempotent: s["isIdempotent"] as boolean,
              plannedBy: agentId,
            },
          },
          {
            eventType: "TaskStepStarted",
            actor: agentId,
            taskId: id,
            payload: {
              stepId: s["stepId"] as string,
              taskId: id,
              startedBy: agentId,
            },
          },
        ],
        correlationId
      );

      await snapshots.rebuildAll();

      res.status(201).json({
        events,
        stepId: s["stepId"],
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to record step progress" });
    }
  });

  // ─── POST /tasks/:id/complete ──────────────────────────────────────────────

  /**
   * Mark a task step as complete (after validation passes).
   * Writes TaskStepCompleted + ArtifactsObserved together.
   *
   * Body: {
   *   agent: AgentId
   *   stepId: string
   *   actualFilesChanged: string[]
   *   gitDiffHash: string | null
   *   validationPassed: boolean
   *   notes?: string
   * }
   */
  router.post("/:id/complete", async (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body as {
      agent: unknown;
      stepId: unknown;
      actualFilesChanged: unknown;
      gitDiffHash: unknown;
      validationPassed: unknown;
      taskComplete?: unknown;
      notes?: unknown;
    };

    if (!id) { res.status(400).json({ error: "taskId required" }); return; }
    if (typeof body.agent !== "string") {
      res.status(400).json({ error: "agent required" });
      return;
    }
    if (typeof body.stepId !== "string") {
      res.status(400).json({ error: "stepId required" });
      return;
    }
    if (!Array.isArray(body.actualFilesChanged)) {
      res.status(400).json({ error: "actualFilesChanged must be an array" });
      return;
    }

    const agentId = body.agent as AgentId;
    const correlationId = uuidv4();
    const taskComplete = body.taskComplete === true;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eventsToWrite: any[] = [
        {
          eventType: "TaskStepCompleted" as const,
          actor: agentId,
          taskId: id,
          payload: {
            stepId: body.stepId,
            taskId: id,
            completedBy: agentId,
            actualFilesChanged: body.actualFilesChanged as string[],
            gitDiffHash: typeof body.gitDiffHash === "string"
              ? body.gitDiffHash : null,
            validationPassed: body.validationPassed === true,
            notes: typeof body.notes === "string" ? body.notes : null,
          },
        },
        {
          eventType: "ArtifactsObserved" as const,
          actor: agentId,
          taskId: id,
          payload: {
            stepId: body.stepId,
            taskId: id,
            filesChanged: body.actualFilesChanged as string[],
            gitDiffHash: typeof body.gitDiffHash === "string"
              ? body.gitDiffHash : null,
            observedBy: agentId,
          },
        },
      ];

      // If all steps done, also mark task complete
      if (taskComplete) {
        const tasksSnapshot = await snapshots.readTasksSnapshot();
        const task = tasksSnapshot?.tasks[id];
        const artifacts = task?.steps
          .flatMap((s) => s.result?.actualFilesChanged ?? []) ?? [];

        eventsToWrite.push({
          eventType: "TaskCompleted" as const,
          actor: agentId,
          taskId: id,
          payload: {
            taskId: id,
            completedBy: agentId,
            summary: `Task completed by ${agentId}`,
            artifacts: [...new Set([...artifacts, ...body.actualFilesChanged as string[]])],
            validationsPassed: task?.steps
              .filter((s) => s.status === "completed")
              .map((s) => s.stepId) ?? [],
          },
        });
      }

      const events = await store.appendEvents(eventsToWrite, correlationId);
      await snapshots.rebuildAll();

      res.status(200).json({
        events,
        taskComplete,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to record completion" });
    }
  });

  // ─── POST /tasks/:id/block ─────────────────────────────────────────────────

  /**
   * Mark a task as blocked.
   * Body: { agent: AgentId, reason: string, suggestedResolution?: string }
   */
  router.post("/:id/block", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { agent, reason, suggestedResolution } = req.body as {
      agent: unknown;
      reason: unknown;
      suggestedResolution?: unknown;
    };

    if (!id) { res.status(400).json({ error: "taskId required" }); return; }
    if (typeof agent !== "string") {
      res.status(400).json({ error: "agent required" });
      return;
    }
    if (typeof reason !== "string") {
      res.status(400).json({ error: "reason required" });
      return;
    }

    try {
      const event = await store.appendEvent({
        eventType: "TaskBlocked",
        actor: agent as AgentId,
        taskId: id,
        payload: {
          taskId: id,
          blockedBy: agent as AgentId,
          reason,
          suggestedResolution: typeof suggestedResolution === "string"
            ? suggestedResolution : null,
        },
      });

      await snapshots.rebuildAll();
      res.status(200).json({ event, eventLogVersion: store.version });
    } catch (err) {
      res.status(500).json({ error: "Failed to block task" });
    }
  });

  // ─── POST /tasks/:id/handoff ───────────────────────────────────────────────

  /**
   * Request a handoff to the other agent.
   * Called by an agent that is about to be exhausted (final_flush mode).
   *
   * Body: {
   *   agent: AgentId           (the requesting agent — from)
   *   toAgent: AgentId         (who should take over)
   *   reason: string
   *   contextForFallback: string
   *   doNotTouch?: string[]
   * }
   */
  router.post("/:id/handoff", async (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body as {
      agent: unknown;
      toAgent: unknown;
      reason: unknown;
      contextForFallback: unknown;
      doNotTouch?: unknown;
    };

    if (!id) { res.status(400).json({ error: "taskId required" }); return; }
    if (typeof body.agent !== "string" || typeof body.toAgent !== "string") {
      res.status(400).json({ error: "agent and toAgent required" });
      return;
    }

    try {
      const decision = await handoffManager.triggerManualHandoff(
        id,
        body.toAgent as AgentId,
        typeof body.reason === "string" ? body.reason : "agent requested handoff"
      );

      if (!decision) {
        res.status(409).json({ error: "Handoff could not be initiated" });
        return;
      }

      res.status(200).json({
        decision,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to initiate handoff" });
    }
  });

  // ─── GET /tasks/:id/reconcile ──────────────────────────────────────────────

  /**
   * Get reconciliation instruction for a task.
   * Called by the fallback agent immediately after taking over.
   *
   * This is the critical endpoint for takeover safety.
   * Returns exactly what the fallback agent needs to:
   *   1. Check git diff against last intent
   *   2. Run validation
   *   3. Decide whether to continue or rollback
   */
  router.get("/:id/reconcile", async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id) { res.status(400).json({ error: "taskId required" }); return; }

    try {
      const tasksSnapshot = await snapshots.readTasksSnapshot();
      const task = tasksSnapshot?.tasks[id];

      if (!task) {
        res.status(404).json({ error: `Task not found: ${id}` });
        return;
      }

      const taskEvents = await store.readTaskHistory(id);

      // Find last step planned (intent)
      const lastPlanned = [...taskEvents]
        .reverse()
        .find((e) => e.eventType === "TaskStepPlanned");

      // Find last artifacts observed (reality)
      const lastArtifacts = [...taskEvents]
        .reverse()
        .find((e) => e.eventType === "ArtifactsObserved");

      const currentStep = task.currentStepId
        ? task.steps.find((s) => s.stepId === task.currentStepId)
        : null;

      res.json({
        taskId: id,
        taskStatus: task.status,
        currentStepId: task.currentStepId,
        handoff: task.handoff,

        // What was intended
        lastIntent: lastPlanned?.eventType === "TaskStepPlanned" ? {
          stepId: lastPlanned.payload.stepId,
          summary: lastPlanned.payload.summary,
          targetFiles: lastPlanned.payload.targetFiles,
          validation: lastPlanned.payload.validation,
          nextActionIfSuccess: lastPlanned.payload.nextActionIfSuccess,
          nextActionIfFailure: lastPlanned.payload.nextActionIfFailure,
        } : null,

        // What actually happened
        lastReality: lastArtifacts?.eventType === "ArtifactsObserved" ? {
          filesChanged: lastArtifacts.payload.filesChanged,
          gitDiffHash: lastArtifacts.payload.gitDiffHash,
        } : null,

        // Current step context
        currentStep: currentStep ? {
          stepId: currentStep.stepId,
          summary: currentStep.summary,
          status: currentStep.status,
          targetFiles: currentStep.targetFiles,
          validation: currentStep.validation,
          nextActionIfSuccess: currentStep.nextActionIfSuccess,
          nextActionIfFailure: currentStep.nextActionIfFailure,
        } : null,

        // Reconciliation instructions
        instructions: [
          "1. Read lastIntent.targetFiles and run git diff against them",
          "2. Compare diff against lastIntent.summary",
          "3. Run lastIntent.validation commands",
          "4. If validation passes: mark step complete, continue from nextActionIfSuccess",
          "5. If validation fails: take nextActionIfFailure path",
          "6. If no lastIntent: assess task steps completed so far and resume from next pending step",
        ],

        completedSteps: task.steps.filter((s) => s.status === "completed").length,
        totalSteps: task.steps.length,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to build reconciliation instruction" });
    }
  });

  return router;
}
