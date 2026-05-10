/**
 * api/server.ts
 *
 * The local HTTP server that both Claude and Antigravity talk to.
 * This is the ONLY component allowed to write state.
 *
 * Key design decisions:
 * - Agents send intent-shaped requests. The API validates, enforces schema,
 *   and appends events. Agents never describe "write this to disk."
 * - Every route that mutates state appends an event first, then rebuilds
 *   snapshots. The snapshot is always derived — never directly edited.
 * - Validation is strict. A malformed request is rejected with a clear
 *   error. Partial writes are not possible.
 * - The server is started by the orchestrator after it is ready.
 *   It holds a reference to the orchestrator for coordination calls.
 * - All responses include the current eventLogVersion so agents can
 *   detect if their cached snapshot is stale.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import type { Orchestrator } from "../core/orchestrator.js";
import type { AgentId } from "../schemas/agent.schema.js";
import { HandoffManager } from "../core/handoff-manager.js";
import { eventsRouter } from "./routes/events.js";
import { tasksRouter } from "./routes/tasks.js";
import { agentsRouter } from "./routes/agents.js";
import { snapshotRouter } from "./routes/snapshot.js";
import { stacklitRouter } from "./routes/stacklit.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { handoffRouter } from "./routes/handoff.js";
import type { StacklitBridge } from "../core/stacklit-bridge.js";
import type { EfficiencyTracker } from "../core/efficiency-tracker.js";

// ─── Config ───────────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 3747; // "DS" on a phone keypad — avoids 3000 conflict

// ─── Server factory ───────────────────────────────────────────────────────────

export function createApiServer(
  orchestrator: Orchestrator,
  stacklit?: StacklitBridge,
  efficiency?: EfficiencyTracker
): express.Application {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  // ── Request logging ────────────────────────────────────────────────────────

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const ts = new Date().toISOString();
    console.log(`[api] ${ts} ${req.method} ${req.path}`);
    next();
  });

  // ── Health check ───────────────────────────────────────────────────────────

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      eventLogVersion: orchestrator.getStore().version,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Mount routers ──────────────────────────────────────────────────────────

  app.use("/events",    eventsRouter(orchestrator));
  app.use("/tasks",     tasksRouter(orchestrator));
  app.use("/agents",    agentsRouter(orchestrator));
  app.use("/snapshot",  snapshotRouter(orchestrator));
  app.use("/handoff",   handoffRouter(orchestrator));
  if (stacklit) {
    app.use("/stacklit", stacklitRouter(stacklit));
  }
  app.use("/dashboard", dashboardRouter(orchestrator, efficiency));

  // ── 404 handler ────────────────────────────────────────────────────────────

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // ── Error handler ──────────────────────────────────────────────────────────

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] unhandled error:", err);
    res.status(500).json({
      error: "Internal server error",
      message: err.message,
    });
  });

  return app;
}

export function startApiServer(
  orchestrator: Orchestrator,
  port: number = DEFAULT_PORT,
  stacklit?: StacklitBridge,
  efficiency?: EfficiencyTracker
): void {
  const app = createApiServer(orchestrator, stacklit, efficiency);

  app.listen(port, "127.0.0.1", () => {
    console.log(`[api] listening on http://127.0.0.1:${port}`);
    console.log(`[api] dashboard → http://127.0.0.1:${port}/dashboard`);
    console.log(`[api] agents connect via:`);
    console.log(`[api]   Claude  → MCP server (wraps this API)`);
    console.log(`[api]   Antigravity → skills call http://127.0.0.1:${port}`);
  });
}
