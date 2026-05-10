/**
 * routes/handoff.ts
 *
 * Handoff coordination endpoints.
 * These are higher-level than the task-level handoff in tasks.ts —
 * they operate at the agent level, not the task level.
 *
 * Endpoints:
 *   POST /handoff/request    → agent requests global handoff to other agent
 *   GET  /handoff/status     → current handoff state across all tasks
 *   POST /handoff/recover    → agent signals it is ready to resume after recovery
 */

import { Router, type Request, type Response } from "express";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { AgentId } from "../../schemas/agent.schema.js";

export function handoffRouter(orchestrator: Orchestrator): Router {
  const router = Router();
  const store = orchestrator.getStore();
  const snapshots = orchestrator.getSnapshots();
  const handoffManager = orchestrator.getHandoffManager();

  // ─── POST /handoff/request ─────────────────────────────────────────────────

  /**
   * Agent requests a global handoff — all its active tasks go to the other agent.
   * Used when an agent is entering final_flush mode and wants to cleanly transfer
   * all work before going offline.
   *
   * Body: {
   *   fromAgent: AgentId
   *   reason: string
   *   contextForFallback?: string  (global context for all handed-off tasks)
   * }
   */
  router.post("/request", async (req: Request, res: Response) => {
    const { fromAgent, reason, contextForFallback } = req.body as {
      fromAgent: unknown;
      reason: unknown;
      contextForFallback?: unknown;
    };

    if (
      typeof fromAgent !== "string" ||
      (fromAgent !== "claude" && fromAgent !== "antigravity")
    ) {
      res.status(400).json({
        error: "fromAgent must be 'claude' or 'antigravity'",
      });
      return;
    }

    if (typeof reason !== "string" || reason.trim().length === 0) {
      res.status(400).json({ error: "reason is required" });
      return;
    }

    try {
      const tasksSnapshot = await snapshots.readTasksSnapshot();
      if (!tasksSnapshot) {
        res.status(503).json({ error: "Snapshots not ready" });
        return;
      }

      // Find all active tasks held by this agent
      const activeTasks = [
        ...tasksSnapshot.byStatus["claimed"],
        ...tasksSnapshot.byStatus["in_progress"],
      ].filter((id) => {
        const task = tasksSnapshot.tasks[id];
        return task?.assignedTo === fromAgent || task?.lease?.claimedBy === fromAgent;
      });

      const toAgent: AgentId = fromAgent === "claude" ? "antigravity" : "claude";
      const decisions: unknown[] = [];

      // Hand off each active task
      for (const taskId of activeTasks) {
        const decision = await handoffManager.triggerManualHandoff(
          taskId,
          toAgent,
          reason
        );
        if (decision) {
          decisions.push(decision);
        }
      }

      // Update agent health to exhausted after handoff
      await store.appendEvent({
        eventType: "AgentStatusObserved",
        actor: fromAgent as AgentId,
        payload: {
          agentId: fromAgent as AgentId,
          health: "final_flush",
          confidence: "high",
          reason: `Initiated global handoff: ${reason}`,
        },
      });

      await snapshots.rebuildAll();

      res.status(200).json({
        fromAgent,
        toAgent,
        tasksHandedOff: decisions.length,
        taskIds: activeTasks,
        decisions,
        reason,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: "Handoff request failed" });
    }
  });

  // ─── GET /handoff/status ───────────────────────────────────────────────────

  /**
   * Get current handoff state — which tasks are pending handoff,
   * which agent is in fallback mode, handoff history.
   */
  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const [tasksSnapshot, agentsSnapshot] = await Promise.all([
        snapshots.readTasksSnapshot(),
        snapshots.readAgentsSnapshot(),
      ]);

      if (!tasksSnapshot || !agentsSnapshot) {
        res.status(503).json({ error: "Snapshots not ready" });
        return;
      }

      const handoffPendingIds = tasksSnapshot.byStatus["handoff_pending"] ?? [];
      const handoffPendingTasks = handoffPendingIds.map((id) => {
        const task = tasksSnapshot.tasks[id];
        return {
          taskId: id,
          title: task?.title,
          fromAgent: task?.handoff?.fromAgent,
          toAgent: task?.handoff?.toAgent,
          reason: task?.handoff?.triggeredBy,
          handedOffAt: task?.handoff?.handedOffAt,
          nextStep: task?.handoff?.nextStepSummary,
        };
      });

      // Agent fallback status
      const claudeAgent = agentsSnapshot.agents["claude"];
      const agAgent = agentsSnapshot.agents["antigravity"];

      res.json({
        handoffPendingCount: handoffPendingIds.length,
        handoffPendingTasks,
        agentStatus: {
          claude: {
            status: claudeAgent?.status,
            health: claudeAgent?.health,
            isInFallbackMode: claudeAgent?.isInFallbackMode,
          },
          antigravity: {
            status: agAgent?.status,
            health: agAgent?.health,
            isInFallbackMode: agAgent?.isInFallbackMode,
            estimatedResetAt: agAgent?.tokenHealth.estimatedResetAt,
          },
        },
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to get handoff status" });
    }
  });

  // ─── POST /handoff/recover ─────────────────────────────────────────────────

  /**
   * Agent signals it has recovered and is ready to resume work.
   * Called by Antigravity after weekly reset, or Claude after a new session.
   *
   * Body: { agent: AgentId, reason: string }
   *
   * Effect:
   * - Marks agent as available
   * - Emits AgentRecovered event
   * - Returns list of tasks in handoff_pending that should be reconciled
   */
  router.post("/recover", async (req: Request, res: Response) => {
    const { agent, reason } = req.body as {
      agent: unknown;
      reason: unknown;
    };

    if (
      typeof agent !== "string" ||
      (agent !== "claude" && agent !== "antigravity")
    ) {
      res.status(400).json({ error: "agent must be 'claude' or 'antigravity'" });
      return;
    }

    if (typeof reason !== "string" || reason.trim().length === 0) {
      res.status(400).json({ error: "reason is required" });
      return;
    }

    try {
      // Delegate to orchestrator's agent status handler
      await orchestrator.handleAgentStatusUpdate(
        agent as AgentId,
        "normal",
        reason
      );

      // Find tasks that were handed to this agent and are pending pickup
      const tasksSnapshot = await snapshots.readTasksSnapshot();
      const agentsSnapshot = await snapshots.readAgentsSnapshot();

      const handoffPendingForAgent = (
        tasksSnapshot?.byStatus["handoff_pending"] ?? []
      ).filter((id) => {
        const task = tasksSnapshot?.tasks[id];
        return task?.handoff?.toAgent === agent;
      });

      const tasksToReconcile = handoffPendingForAgent.map((id) => {
        const task = tasksSnapshot?.tasks[id];
        return {
          taskId: id,
          title: task?.title,
          lastStep: task?.handoff?.nextStepSummary,
          contextForFallback: task?.handoff?.contextForFallback,
          reconcileUrl: `/tasks/${id}/reconcile`,
        };
      });

      res.json({
        recovered: true,
        agent,
        agentHealth: agentsSnapshot?.agents[agent as AgentId]?.health,
        tasksToReconcile,
        reconcileCount: tasksToReconcile.length,
        message: tasksToReconcile.length > 0
          ? `You have ${tasksToReconcile.length} task(s) to reconcile. Call GET /tasks/:id/reconcile for each.`
          : "No tasks pending reconciliation. Check /snapshot/orientation for available work.",
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Recovery failed" });
    }
  });

  return router;
}
