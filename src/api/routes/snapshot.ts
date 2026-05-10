/**
 * routes/snapshot.ts
 *
 * Fast snapshot read endpoints.
 * Agents read these — they never read events.jsonl directly.
 *
 * Key: scoped reads minimize token cost.
 * GET /snapshot?scope=active&agent=claude returns only what Claude
 * needs right now — not all 200 tasks from a long-running project.
 *
 * Endpoints:
 *   GET /snapshot              → full combined snapshot
 *   GET /snapshot/tasks        → tasks snapshot (filterable)
 *   GET /snapshot/agents       → agents snapshot
 *   GET /snapshot/project      → project snapshot
 *   GET /snapshot/stale        → staleness check
 *   GET /snapshot/orientation  → minimal session-start orientation (<6k tokens)
 */

import { Router, type Request, type Response } from "express";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { AgentId } from "../../schemas/agent.schema.js";

export function snapshotRouter(orchestrator: Orchestrator): Router {
  const router = Router();
  const store = orchestrator.getStore();
  const snapshots = orchestrator.getSnapshots();

  // ─── GET /snapshot ─────────────────────────────────────────────────────────

  /**
   * Full combined snapshot — all three files.
   * Use only for full session initialization. Too large for mid-task reads.
   */
  router.get("/", async (_req: Request, res: Response) => {
    try {
      const [tasks, agents, project] = await Promise.all([
        snapshots.readTasksSnapshot(),
        snapshots.readAgentsSnapshot(),
        snapshots.readProjectSnapshot(),
      ]);

      res.json({
        tasks,
        agents,
        project,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read snapshot" });
    }
  });

  // ─── GET /snapshot/tasks ───────────────────────────────────────────────────

  /**
   * Tasks snapshot with optional scope filtering.
   *
   * Query params:
   *   scope=active    → only non-completed, non-cancelled tasks
   *   agent=claude    → only tasks assigned to or eligible for claude
   *   limit=N         → max tasks returned (default 20, max 100)
   *
   * This is the primary endpoint agents call mid-session.
   */
  router.get("/tasks", async (req: Request, res: Response) => {
    const { scope, agent, limit } = req.query;

    try {
      const tasksSnapshot = await snapshots.readTasksSnapshot();
      if (!tasksSnapshot) {
        res.json({ tasks: {}, eventLogVersion: store.version });
        return;
      }

      let tasks = Object.values(tasksSnapshot.tasks);

      // scope=active — filter out terminal states
      if (scope === "active") {
        tasks = tasks.filter(
          (t) => !["completed", "cancelled"].includes(t.status)
        );
      }

      // agent filter — tasks relevant to this agent
      if (agent && typeof agent === "string") {
        const agentId = agent as AgentId;
        tasks = tasks.filter(
          (t) =>
            t.assignedTo === agentId ||
            t.primaryAgent === agentId ||
            t.fallbackAgent === agentId
        );
      }

      // Priority sort
      const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
      tasks.sort(
        (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
      );

      // Limit
      const limitN = limit
        ? Math.min(parseInt(String(limit), 10), 100)
        : 20;
      const paginated = tasks.slice(0, limitN);

      // Build indexed response (tasks as Record for fast lookup)
      const indexed = Object.fromEntries(
        paginated.map((t) => [t.taskId, t])
      );

      res.json({
        tasks: indexed,
        total: tasks.length,
        returned: paginated.length,
        criticalPath: tasksSnapshot.criticalPath,
        byStatus: tasksSnapshot.byStatus,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read tasks snapshot" });
    }
  });

  // ─── GET /snapshot/agents ──────────────────────────────────────────────────

  router.get("/agents", async (_req: Request, res: Response) => {
    try {
      const agentsSnapshot = await snapshots.readAgentsSnapshot();

      if (!agentsSnapshot) {
        res.json({ agents: {}, eventLogVersion: store.version });
        return;
      }

      res.json({
        agents: agentsSnapshot.agents,
        generatedAt: agentsSnapshot.generatedAt,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read agents snapshot" });
    }
  });

  // ─── GET /snapshot/project ─────────────────────────────────────────────────

  router.get("/project", async (_req: Request, res: Response) => {
    try {
      const projectSnapshot = await snapshots.readProjectSnapshot();

      if (!projectSnapshot) {
        res.json({ project: null, eventLogVersion: store.version });
        return;
      }

      res.json({
        project: projectSnapshot,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read project snapshot" });
    }
  });

  // ─── GET /snapshot/stale ───────────────────────────────────────────────────

  /**
   * Quick staleness check. Returns true if snapshots need rebuilding.
   * Agents call this before reading snapshots to know if they're fresh.
   */
  router.get("/stale", async (_req: Request, res: Response) => {
    try {
      const isStale = await snapshots.isStale();

      if (isStale) {
        // Rebuild on demand
        await snapshots.rebuildAll();
      }

      res.json({
        wasStale: isStale,
        rebuilt: isStale,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to check staleness" });
    }
  });

  // ─── GET /snapshot/orientation ─────────────────────────────────────────────

  /**
   * Minimal session-start orientation for an agent.
   * Designed to cost under 2k tokens for most projects.
   *
   * Returns only what an agent needs to start working:
   * - Project goal and current milestone
   * - Both agents' health
   * - Active tasks assigned to this agent (max 5)
   * - Pending tasks available to claim (max 10)
   * - Critical path task IDs
   *
   * Query: ?agent=claude | ?agent=antigravity
   */
  router.get("/orientation", async (req: Request, res: Response) => {
    const { agent } = req.query;

    if (!agent || typeof agent !== "string") {
      res.status(400).json({
        error: "agent query param required",
        example: "/snapshot/orientation?agent=claude",
      });
      return;
    }

    const agentId = agent as AgentId;

    try {
      const [tasks, agents, project] = await Promise.all([
        snapshots.readTasksSnapshot(),
        snapshots.readAgentsSnapshot(),
        snapshots.readProjectSnapshot(),
      ]);

      if (!tasks || !agents || !project) {
        res.status(503).json({ error: "Snapshots not ready yet" });
        return;
      }

      // Active tasks for this agent
      const myActiveTasks = Object.values(tasks.tasks)
        .filter(
          (t) =>
            t.assignedTo === agentId &&
            !["completed", "cancelled"].includes(t.status)
        )
        .slice(0, 5)
        .map((t) => ({
          taskId: t.taskId,
          title: t.title,
          status: t.status,
          priority: t.priority,
          currentStepId: t.currentStepId,
          lease: t.lease
            ? {
                expiresAt: t.lease.expiresAt,
                attemptNumber: t.lease.attemptNumber,
              }
            : null,
        }));

      // Pending tasks available to claim
      const availableTasks = tasks.byStatus["pending"]
        .map((id) => tasks.tasks[id])
        .filter(
          (t): t is NonNullable<typeof t> =>
            !!t &&
            (t.primaryAgent === agentId || t.fallbackAgent === agentId)
        )
        .slice(0, 10)
        .map((t) => ({
          taskId: t.taskId,
          title: t.title,
          type: t.type,
          priority: t.priority,
          primaryAgent: t.primaryAgent,
          dependsOn: t.dependsOn,
        }));

      // Both agents' health
      const agentHealth = {
        claude: {
          status: agents.agents.claude?.status,
          health: agents.agents.claude?.health,
          isInFallbackMode: agents.agents.claude?.isInFallbackMode,
        },
        antigravity: {
          status: agents.agents.antigravity?.status,
          health: agents.agents.antigravity?.health,
          isInFallbackMode: agents.agents.antigravity?.isInFallbackMode,
          estimatedResetAt:
            agents.agents.antigravity?.tokenHealth.estimatedResetAt,
        },
      };

      res.json({
        // Project context
        goal: project.goal,
        currentMilestone: project.currentMilestone,
        openTaskCount: project.openTaskCount,
        completedTaskCount: project.completedTaskCount,
        lastCheckpointAt: project.lastCheckpointAt,

        // Agent context
        agentHealth,
        isInFallbackMode: agents.agents[agentId]?.isInFallbackMode ?? false,

        // Work context
        myActiveTasks,
        availableTasks,
        criticalPath: tasks.criticalPath.slice(0, 5),

        // Meta
        eventLogVersion: store.version,
        snapshotAge: tasks.generatedAt,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to build orientation" });
    }
  });

  return router;
}
