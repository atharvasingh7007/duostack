/**
 * routes/agents.ts
 *
 * Agent availability and health endpoints.
 *
 * Endpoints:
 *   GET  /agents             → both agents' current snapshot
 *   GET  /agents/:id         → single agent snapshot
 *   POST /agents/status      → agent self-reports health (recovery, triage, exhaustion)
 *   POST /agents/override    → developer forces agent status
 */

import { Router, type Request, type Response } from "express";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { AgentId } from "../../schemas/agent.schema.js";

const VALID_AGENT_IDS: Set<AgentId> = new Set(["claude", "antigravity"]);

const VALID_HEALTH_LEVELS = new Set([
  "normal", "batching", "triage", "final_flush", "exhausted",
]);

export function agentsRouter(orchestrator: Orchestrator): Router {
  const router = Router();
  const store = orchestrator.getStore();
  const snapshots = orchestrator.getSnapshots();

  // ─── GET /agents ───────────────────────────────────────────────────────────

  router.get("/", async (_req: Request, res: Response) => {
    try {
      const agentsSnapshot = await snapshots.readAgentsSnapshot();

      if (!agentsSnapshot) {
        res.json({
          agents: {},
          eventLogVersion: store.version,
        });
        return;
      }

      res.json({
        agents: agentsSnapshot.agents,
        generatedAt: agentsSnapshot.generatedAt,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read agents" });
    }
  });

  // ─── GET /agents/:id ───────────────────────────────────────────────────────

  router.get("/:id", async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || !VALID_AGENT_IDS.has(id as AgentId)) {
      res.status(400).json({
        error: `Invalid agent id: ${id}`,
        valid: [...VALID_AGENT_IDS],
      });
      return;
    }

    try {
      const agentsSnapshot = await snapshots.readAgentsSnapshot();
      const agent = agentsSnapshot?.agents[id as AgentId];

      if (!agent) {
        res.status(404).json({ error: `Agent not found: ${id}` });
        return;
      }

      res.json({
        agent,
        eventLogVersion: store.version,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read agent" });
    }
  });

  // ─── POST /agents/status ───────────────────────────────────────────────────

  /**
   * Agent self-reports health status.
   * This is the primary signal the orchestrator uses to detect
   * recovery, token pressure, and exhaustion.
   *
   * Body: {
   *   agent: AgentId
   *   health: "normal" | "batching" | "triage" | "final_flush" | "exhausted"
   *   reason: string
   * }
   *
   * Called by agents when:
   *   - Starting a new session (normal)
   *   - Noticing token pressure (batching → triage → final_flush)
   *   - Hitting a limit (exhausted)
   *   - Recovering from a limit reset (normal again)
   */
  router.post("/status", async (req: Request, res: Response) => {
    const { agent, health, reason } = req.body as {
      agent: unknown;
      health: unknown;
      reason: unknown;
    };

    if (typeof agent !== "string" || !VALID_AGENT_IDS.has(agent as AgentId)) {
      res.status(400).json({
        error: "Invalid agent",
        valid: [...VALID_AGENT_IDS],
      });
      return;
    }

    if (typeof health !== "string" || !VALID_HEALTH_LEVELS.has(health)) {
      res.status(400).json({
        error: "Invalid health level",
        valid: [...VALID_HEALTH_LEVELS],
      });
      return;
    }

    if (typeof reason !== "string" || reason.trim().length === 0) {
      res.status(400).json({ error: "reason is required" });
      return;
    }

    try {
      await orchestrator.handleAgentStatusUpdate(
        agent as AgentId,
        health,
        reason
      );

      const agentsSnapshot = await snapshots.readAgentsSnapshot();
      const updatedAgent = agentsSnapshot?.agents[agent as AgentId];

      res.status(200).json({
        agent: updatedAgent,
        eventLogVersion: store.version,
        message: `Agent ${agent} status updated to ${health}`,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to update agent status" });
    }
  });

  // ─── POST /agents/override ─────────────────────────────────────────────────

  /**
   * Developer forces an agent's availability status.
   * Used for: manually marking Antigravity available after weekly reset,
   * or marking Claude unavailable during a planned context reset.
   *
   * Body: {
   *   agent: AgentId
   *   forcedStatus: "available" | "unavailable"
   *   reason: string
   *   expiresAt?: string  (ISO 8601 — when override auto-clears)
   * }
   */
  router.post("/override", async (req: Request, res: Response) => {
    const { agent, forcedStatus, reason, expiresAt } = req.body as {
      agent: unknown;
      forcedStatus: unknown;
      reason: unknown;
      expiresAt?: unknown;
    };

    if (typeof agent !== "string" || !VALID_AGENT_IDS.has(agent as AgentId)) {
      res.status(400).json({ error: "Invalid agent" });
      return;
    }

    if (forcedStatus !== "available" && forcedStatus !== "unavailable") {
      res.status(400).json({
        error: "forcedStatus must be 'available' or 'unavailable'",
      });
      return;
    }

    if (typeof reason !== "string" || reason.trim().length === 0) {
      res.status(400).json({ error: "reason is required" });
      return;
    }

    try {
      await store.appendEvent({
        eventType: "ManualOverrideSet",
        actor: "developer",
        payload: {
          agentId: agent as AgentId,
          setBy: "developer",
          forcedStatus,
          reason,
          expiresAt: typeof expiresAt === "string" ? expiresAt : null,
        },
      });

      await snapshots.rebuildAll();

      const agentsSnapshot = await snapshots.readAgentsSnapshot();
      const updatedAgent = agentsSnapshot?.agents[agent as AgentId];

      res.status(200).json({
        agent: updatedAgent,
        eventLogVersion: store.version,
        message: `Override set: ${agent} → ${forcedStatus}`,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to set override" });
    }
  });

  return router;
}
