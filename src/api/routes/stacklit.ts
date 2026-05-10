/**
 * routes/stacklit.ts
 *
 * Codebase navigation endpoints powered by Stacklit.
 * Both agents call these to orient without burning tokens exploring files.
 *
 * Endpoints:
 *   GET /stacklit/status           → is Stacklit available + stats
 *   GET /stacklit/context          → token-health-aware context read
 *   GET /stacklit/module/:query    → single module lookup
 *   GET /stacklit/deps/:module     → dependency graph for a module
 *   GET /stacklit/full             → full stacklit.json index
 */

import { Router, type Request, type Response } from "express";
import type { StacklitBridge } from "../../core/stacklit-bridge.js";

export function stacklitRouter(bridge: StacklitBridge): Router {
  const router = Router();

  // ─── GET /stacklit/status ──────────────────────────────────────────────────

  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const stats = await bridge.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: "Failed to get Stacklit status" });
    }
  });

  // ─── GET /stacklit/context ─────────────────────────────────────────────────

  /**
   * Token-health-aware context read.
   * The agent passes its current token health and optionally a module query.
   * Returns the right amount of context without the agent having to decide.
   *
   * Query params:
   *   health=normal|batching|triage|final_flush|exhausted
   *   module=<query>   (optional — for mcp_query mode)
   *
   * This is the primary endpoint agents call for codebase orientation.
   */
  router.get("/context", async (req: Request, res: Response) => {
    const { health, module: moduleQuery } = req.query;

    if (!health || typeof health !== "string") {
      res.status(400).json({
        error: "health query param required",
        example: "/stacklit/context?health=normal",
        validValues: ["normal", "batching", "triage", "final_flush", "exhausted"],
      });
      return;
    }

    try {
      const result = await bridge.readForTokenHealth(
        health,
        typeof moduleQuery === "string" ? moduleQuery : undefined
      );

      res.json({
        mode: result.mode,
        estimatedTokens: result.estimatedTokens,
        available: bridge.isAvailable(),
        data: result.data,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read Stacklit context" });
    }
  });

  // ─── GET /stacklit/module/:query ───────────────────────────────────────────

  /**
   * Look up a specific module by path or keyword.
   * Supports fuzzy matching — "auth" matches "src/auth", "src/auth/index.ts".
   * Cheapest Stacklit read — use this when you need info about one module.
   */
  router.get("/module/:query", async (req: Request, res: Response) => {
    const { query } = req.params;

    if (!query) {
      res.status(400).json({ error: "query param required" });
      return;
    }

    try {
      const result = await bridge.queryModule(query);

      if (!result.found) {
        res.status(404).json({
          found: false,
          query,
          message: `No module matching '${query}' found in stacklit.json`,
        });
        return;
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to query module" });
    }
  });

  // ─── GET /stacklit/deps/:module ────────────────────────────────────────────

  /**
   * Get dependency graph for a module up to depth N.
   * Use before planning a refactor — understand what you'll break.
   *
   * Query params:
   *   depth=2   (default 2, max 4)
   */
  router.get("/deps/:module", async (req: Request, res: Response) => {
    const { module: moduleName } = req.params;
    const depth = Math.min(
      parseInt(String(req.query["depth"] ?? "2"), 10),
      4
    );

    if (!moduleName) {
      res.status(400).json({ error: "module param required" });
      return;
    }

    try {
      const graph = await bridge.getDependencyGraph(moduleName, depth);

      res.json({
        module: moduleName,
        depth,
        graph,
        nodeCount: Object.keys(graph).length,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to get dependency graph" });
    }
  });

  // ─── GET /stacklit/full ────────────────────────────────────────────────────

  /**
   * Full stacklit.json index.
   * Use only when you need complete codebase context.
   * ~4k tokens for most projects.
   */
  router.get("/full", async (_req: Request, res: Response) => {
    try {
      const index = await bridge.readFullIndex();

      if (!index) {
        res.status(404).json({
          available: false,
          message: "stacklit.json not found — run: npx stacklit@0.3.0 init --hook",
        });
        return;
      }

      res.json({
        available: true,
        index,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to read Stacklit index" });
    }
  });

  return router;
}
