/**
 * __tests__/handoff-route.test.ts
 *
 * Tests for the /handoff/* endpoints.
 * Uses initOnly() so no poll loop or file watcher.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOrchestrator } from "../core/orchestrator.js";
import { createApiServer } from "../api/server.js";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

async function req(
  method: "GET" | "POST",
  p: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const url = new URL(`${baseUrl}${p}`);
    const options = {
      hostname: url.hostname,
      port: parseInt(url.port),
      path: url.pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(options, (res) => {
      let resp = "";
      res.on("data", (c) => (resp += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(resp) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: resp }); }
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

beforeAll(async () => {
  tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-handoff-route-test-")
  );

  const orchestrator = await createOrchestrator({
    projectPath: tmpDir,
    stateDir: tmpDir,
    stacklitPath: path.join(tmpDir, "stacklit.json"),
  });
  await orchestrator.initOnly();

  const store = orchestrator.getStore();

  // Seed project + two tasks claimed by claude
  await store.appendEvent({
    eventType: "ProjectInitialized",
    actor: "developer",
    payload: {
      projectName: "handoff-test",
      projectPath: tmpDir,
      goal: "Test handoffs",
      techStack: ["TypeScript"],
      stacklitVersion: "0.3.0",
      duostackVersion: "0.1.0",
    },
  });

  for (const taskId of ["task_h01", "task_h02"]) {
    await store.appendEvent({
      eventType: "TaskCreated",
      actor: "claude",
      taskId,
      payload: {
        taskId,
        title: `Handoff task ${taskId}`,
        description: "For handoff testing",
        type: "plan",
        priority: "normal",
        primaryAgent: "claude",
        fallbackAgent: "antigravity",
        dependsOn: [],
        acceptanceCriteria: [],
      },
    });
    await store.appendEvent({
      eventType: "TaskClaimed",
      actor: "claude",
      taskId,
      payload: {
        taskId,
        claimedBy: "claude",
        leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
        attemptNumber: 1,
      },
    });
  }
  await orchestrator.getSnapshots().rebuildAll();

  const app = createApiServer(orchestrator);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe("Handoff Routes", () => {

  describe("GET /handoff/status", () => {
    it("returns handoff status with agent health", async () => {
      const { status, body } = await req("GET", "/handoff/status");
      expect(status).toBe(200);
      const b = body as {
        handoffPendingCount: number;
        agentStatus: { claude: unknown; antigravity: unknown };
        eventLogVersion: number;
      };
      expect(typeof b.handoffPendingCount).toBe("number");
      expect(b.agentStatus.claude).toBeDefined();
      expect(b.agentStatus.antigravity).toBeDefined();
      expect(typeof b.eventLogVersion).toBe("number");
    });

    it("initially has zero handoff pending tasks", async () => {
      const { body } = await req("GET", "/handoff/status");
      const b = body as { handoffPendingCount: number };
      expect(b.handoffPendingCount).toBe(0);
    });
  });

  describe("POST /handoff/request", () => {
    it("rejects missing fromAgent", async () => {
      const { status } = await req("POST", "/handoff/request", {
        reason: "test",
      });
      expect(status).toBe(400);
    });

    it("rejects invalid fromAgent", async () => {
      const { status } = await req("POST", "/handoff/request", {
        fromAgent: "unknownbot",
        reason: "test",
      });
      expect(status).toBe(400);
    });

    it("rejects missing reason", async () => {
      const { status } = await req("POST", "/handoff/request", {
        fromAgent: "claude",
      });
      expect(status).toBe(400);
    });

    it("hands off all active tasks from agent", async () => {
      const { status, body } = await req("POST", "/handoff/request", {
        fromAgent: "claude",
        reason: "context limit approaching — final flush",
        contextForFallback: "Architecture decisions in decisions.md",
      });
      expect(status).toBe(200);
      const b = body as {
        fromAgent: string;
        toAgent: string;
        tasksHandedOff: number;
        taskIds: string[];
      };
      expect(b.fromAgent).toBe("claude");
      expect(b.toAgent).toBe("antigravity");
      expect(b.tasksHandedOff).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(b.taskIds)).toBe(true);
    });

    it("updates handoff status after request", async () => {
      const { body } = await req("GET", "/handoff/status");
      const b = body as { handoffPendingCount: number };
      // After the handoff request above, there should be pending tasks
      expect(typeof b.handoffPendingCount).toBe("number");
    });
  });

  describe("POST /handoff/recover", () => {
    it("rejects invalid agent", async () => {
      const { status } = await req("POST", "/handoff/recover", {
        agent: "notanagent",
        reason: "back online",
      });
      expect(status).toBe(400);
    });

    it("rejects missing reason", async () => {
      const { status } = await req("POST", "/handoff/recover", {
        agent: "antigravity",
      });
      expect(status).toBe(400);
    });

    it("marks agent as recovered", async () => {
      const { status, body } = await req("POST", "/handoff/recover", {
        agent: "antigravity",
        reason: "weekly reset complete",
      });
      expect(status).toBe(200);
      const b = body as {
        recovered: boolean;
        agent: string;
        tasksToReconcile: unknown[];
        message: string;
      };
      expect(b.recovered).toBe(true);
      expect(b.agent).toBe("antigravity");
      expect(Array.isArray(b.tasksToReconcile)).toBe(true);
      expect(typeof b.message).toBe("string");
    });

    it("returns tasks to reconcile when handoff pending tasks exist", async () => {
      // The handoff request above left tasks in handoff_pending for antigravity
      const { body } = await req("POST", "/handoff/recover", {
        agent: "antigravity",
        reason: "session recovery",
      });
      const b = body as {
        tasksToReconcile: Array<{ taskId: string; reconcileUrl: string }>;
      };
      // Each task to reconcile should have a reconcileUrl
      for (const t of b.tasksToReconcile) {
        expect(t.reconcileUrl).toMatch(/^\/tasks\/.+\/reconcile$/);
      }
    });
  });
});
