/**
 * __tests__/server.test.ts
 *
 * Integration test that boots the real Express API server and hits
 * every major endpoint with real HTTP requests.
 *
 * Uses initOnly() to skip orchestrator poll loop and file watcher —
 * just the event store, snapshot builder, and Express routes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOrchestrator } from "../core/orchestrator.js";
import { createApiServer } from "../api/server.js";

// ─── Shared state ─────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiGet(p: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${p}`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    }).on("error", reject);
  });
}

async function apiPost(
  p: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${baseUrl}${p}`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: parseInt(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let resp = "";
        res.on("data", (c) => (resp += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(resp) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: resp });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-server-test-")
  );

  const orchestrator = await createOrchestrator({
    projectPath: tmpDir,
    stateDir: tmpDir,
    stacklitPath: path.join(tmpDir, "stacklit.json"),
  });

  // initOnly: initializes store + snapshots, skips poll/watcher/lock
  await orchestrator.initOnly();

  // Seed with a project and a task
  const store = orchestrator.getStore();
  await store.appendEvent({
    eventType: "ProjectInitialized",
    actor: "developer",
    payload: {
      projectName: "test-project",
      projectPath: tmpDir,
      goal: "Test the API server",
      techStack: ["TypeScript"],
      stacklitVersion: "0.3.0",
      duostackVersion: "0.1.0",
    },
  });
  await store.appendEvent({
    eventType: "TaskCreated",
    actor: "claude",
    taskId: "task_srv_001",
    payload: {
      taskId: "task_srv_001",
      title: "Server test task",
      description: "Testing API",
      type: "build",
      priority: "normal",
      primaryAgent: "antigravity",
      fallbackAgent: "claude",
      dependsOn: [],
      acceptanceCriteria: ["API works"],
    },
  });
  await orchestrator.getSnapshots().rebuildAll();

  // Bind Express to a random port
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("API Server", () => {

  // ── Health ─────────────────────────────────────────────────────────────────

  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      const { status, body } = await apiGet("/health");
      expect(status).toBe(200);
      expect((body as { status: string }).status).toBe("ok");
    });

    it("includes eventLogVersion", async () => {
      const { body } = await apiGet("/health");
      expect(typeof (body as { eventLogVersion: number }).eventLogVersion).toBe("number");
    });
  });

  // ── Events ─────────────────────────────────────────────────────────────────

  describe("POST /events", () => {
    it("appends a valid event and returns 201", async () => {
      const { status, body } = await apiPost("/events", {
        eventType: "TaskCreated",
        actor: "claude",
        taskId: "task_srv_002",
        payload: {
          taskId: "task_srv_002",
          title: "Second server test task",
          description: "Also testing API",
          type: "plan",
          priority: "low",
          primaryAgent: "claude",
          fallbackAgent: "antigravity",
          dependsOn: [],
          acceptanceCriteria: [],
        },
      });
      expect(status).toBe(201);
      const b = body as { event: { eventType: string }; eventLogVersion: number };
      expect(b.event.eventType).toBe("TaskCreated");
      expect(b.eventLogVersion).toBeGreaterThan(0);
    });

    it("rejects invalid eventType with 400", async () => {
      const { status, body } = await apiPost("/events", {
        eventType: "NotARealEventType",
        actor: "claude",
        payload: {},
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toContain("eventType");
    });

    it("rejects invalid actor with 400", async () => {
      const { status } = await apiPost("/events", {
        eventType: "TaskCreated",
        actor: "hackerAgent",
        taskId: "task_x",
        payload: {},
      });
      expect(status).toBe(400);
    });

    it("rejects orchestrator-only events from agents", async () => {
      const { status, body } = await apiPost("/events", {
        eventType: "TaskLeaseExpired",
        actor: "claude",
        taskId: "task_srv_001",
        payload: {
          taskId: "task_srv_001",
          wasClaimedBy: "antigravity",
          expiredAt: new Date().toISOString(),
          handoffCount: 0,
          willReassign: true,
        },
      });
      expect(status).toBe(403);
      expect((body as { error: string }).error).toContain("orchestrator");
    });

    it("rejects DecisionRecorded from Antigravity", async () => {
      const { status } = await apiPost("/events", {
        eventType: "DecisionRecorded",
        actor: "antigravity",
        payload: {
          decisionId: "D-001",
          title: "Test",
          decision: "Decided",
          rationale: "Because",
          constraints: [],
          status: "FINAL",
          doNotReEvaluate: true,
        },
      });
      expect(status).toBe(403);
    });
  });

  // ── Events read ────────────────────────────────────────────────────────────

  describe("GET /events/recent", () => {
    it("returns recent events array", async () => {
      const { status, body } = await apiGet("/events/recent?n=5");
      expect(status).toBe(200);
      const b = body as { events: unknown[]; count: number };
      expect(Array.isArray(b.events)).toBe(true);
      expect(typeof b.count).toBe("number");
    });
  });

  describe("GET /events/task/:id", () => {
    it("returns task history", async () => {
      const { status, body } = await apiGet("/events/task/task_srv_001");
      expect(status).toBe(200);
      const b = body as { events: unknown[]; taskId: string };
      expect(b.taskId).toBe("task_srv_001");
      expect(Array.isArray(b.events)).toBe(true);
      expect(b.events.length).toBeGreaterThan(0);
    });
  });

  describe("GET /events/stats", () => {
    it("returns event stats", async () => {
      const { status, body } = await apiGet("/events/stats");
      expect(status).toBe(200);
      const b = body as { totalEvents: number };
      expect(typeof b.totalEvents).toBe("number");
      expect(b.totalEvents).toBeGreaterThan(0);
    });
  });

  // ── Tasks ──────────────────────────────────────────────────────────────────

  describe("GET /tasks", () => {
    it("returns task list", async () => {
      const { status, body } = await apiGet("/tasks");
      expect(status).toBe(200);
      const b = body as { tasks: unknown[] };
      expect(Array.isArray(b.tasks)).toBe(true);
      expect(b.tasks.length).toBeGreaterThan(0);
    });

    it("filters by status=pending", async () => {
      const { status, body } = await apiGet("/tasks?status=pending");
      expect(status).toBe(200);
      const b = body as { tasks: Array<{ status: string }> };
      expect(b.tasks.every((t) => t.status === "pending")).toBe(true);
    });
  });

  describe("GET /tasks/:id", () => {
    it("returns single task", async () => {
      const { status, body } = await apiGet("/tasks/task_srv_001");
      expect(status).toBe(200);
      const b = body as { task: { taskId: string } };
      expect(b.task.taskId).toBe("task_srv_001");
    });

    it("returns 404 for unknown task", async () => {
      const { status } = await apiGet("/tasks/definitely_nonexistent");
      expect(status).toBe(404);
    });
  });

  describe("POST /tasks/:id/claim", () => {
    it("claims a pending task", async () => {
      const { status, body } = await apiPost("/tasks/task_srv_001/claim", {
        agent: "antigravity",
      });
      expect(status).toBe(200);
      const b = body as { task: { status: string; assignedTo: string } };
      expect(b.task.status).toBe("claimed");
      expect(b.task.assignedTo).toBe("antigravity");
    });

    it("rejects re-claim of already claimed task", async () => {
      // task_srv_001 is now claimed from previous test
      const { status } = await apiPost("/tasks/task_srv_001/claim", {
        agent: "claude",
      });
      expect(status).toBe(409);
    });
  });

  describe("POST /tasks/:id/progress", () => {
    it("records step intent for in-progress task", async () => {
      const { status, body } = await apiPost("/tasks/task_srv_001/progress", {
        agent: "antigravity",
        step: {
          stepId: "step_srv_001",
          stepNumber: 1,
          summary: "Implement feature",
          targetFiles: ["src/feature.ts"],
          validation: ["pnpm test"],
          nextActionIfSuccess: "Add tests",
          nextActionIfFailure: "Roll back",
          isIdempotent: true,
        },
      });
      expect(status).toBe(201);
      const b = body as { stepId: string };
      expect(b.stepId).toBe("step_srv_001");
    });
  });

  describe("POST /tasks/:id/block", () => {
    it("marks task as blocked", async () => {
      // Create a fresh task to block
      await apiPost("/events", {
        eventType: "TaskCreated",
        actor: "claude",
        taskId: "task_to_block",
        payload: {
          taskId: "task_to_block",
          title: "Task to block",
          description: "Will be blocked",
          type: "build",
          priority: "low",
          primaryAgent: "antigravity",
          fallbackAgent: "claude",
          dependsOn: [],
          acceptanceCriteria: [],
        },
      });
      await apiPost("/tasks/task_to_block/claim", { agent: "antigravity" });

      const { status, body } = await apiPost("/tasks/task_to_block/block", {
        agent: "antigravity",
        reason: "Missing dependency",
        suggestedResolution: "Install package X",
      });
      expect(status).toBe(200);
      const b = body as { event: { eventType: string } };
      expect(b.event.eventType).toBe("TaskBlocked");
    });
  });

  // ── Agents ─────────────────────────────────────────────────────────────────

  describe("GET /agents", () => {
    it("returns both agents", async () => {
      const { status, body } = await apiGet("/agents");
      expect(status).toBe(200);
      const b = body as { agents: Record<string, unknown> };
      expect(b.agents["claude"]).toBeDefined();
      expect(b.agents["antigravity"]).toBeDefined();
    });
  });

  describe("GET /agents/:id", () => {
    it("returns single agent", async () => {
      const { status, body } = await apiGet("/agents/claude");
      expect(status).toBe(200);
      const b = body as { agent: { agentId: string } };
      expect(b.agent.agentId).toBe("claude");
    });

    it("returns 400 for invalid agent id", async () => {
      const { status } = await apiGet("/agents/unknownbot");
      expect(status).toBe(400);
    });
  });

  describe("POST /agents/status", () => {
    it("accepts valid health status", async () => {
      const { status } = await apiPost("/agents/status", {
        agent: "claude",
        health: "normal",
        reason: "session start",
      });
      expect(status).toBe(200);
    });

    it("accepts triage status", async () => {
      const { status } = await apiPost("/agents/status", {
        agent: "antigravity",
        health: "triage",
        reason: "token pressure building",
      });
      expect(status).toBe(200);
    });

    it("rejects invalid health level", async () => {
      const { status } = await apiPost("/agents/status", {
        agent: "claude",
        health: "turbo_mode",
        reason: "test",
      });
      expect(status).toBe(400);
    });

    it("rejects missing reason", async () => {
      const { status } = await apiPost("/agents/status", {
        agent: "claude",
        health: "normal",
      });
      expect(status).toBe(400);
    });
  });

  describe("POST /agents/override", () => {
    it("allows developer to force agent status", async () => {
      const { status, body } = await apiPost("/agents/override", {
        agent: "antigravity",
        forcedStatus: "unavailable",
        reason: "Weekly reset in progress",
      });
      expect(status).toBe(200);
      const b = body as { message: string };
      expect(b.message).toContain("unavailable");
    });
  });

  // ── Snapshots ──────────────────────────────────────────────────────────────

  describe("GET /snapshot/orientation", () => {
    it("returns orientation for claude", async () => {
      const { status, body } = await apiGet("/snapshot/orientation?agent=claude");
      expect(status).toBe(200);
      const b = body as {
        goal: string;
        agentHealth: Record<string, unknown>;
        eventLogVersion: number;
      };
      expect(b.goal).toBeTruthy();
      expect(b.agentHealth["claude"]).toBeDefined();
      expect(typeof b.eventLogVersion).toBe("number");
    });

    it("returns orientation for antigravity", async () => {
      const { status, body } = await apiGet(
        "/snapshot/orientation?agent=antigravity"
      );
      expect(status).toBe(200);
      const b = body as { agentHealth: Record<string, unknown> };
      expect(b.agentHealth["antigravity"]).toBeDefined();
    });

    it("returns 400 without agent param", async () => {
      const { status } = await apiGet("/snapshot/orientation");
      expect(status).toBe(400);
    });
  });

  describe("GET /snapshot/tasks", () => {
    it("returns tasks snapshot", async () => {
      const { status, body } = await apiGet("/snapshot/tasks");
      expect(status).toBe(200);
      const b = body as { tasks: Record<string, unknown> };
      expect(typeof b.tasks).toBe("object");
    });

    it("filters by scope=active", async () => {
      const { status } = await apiGet("/snapshot/tasks?scope=active");
      expect(status).toBe(200);
    });
  });

  describe("GET /snapshot/agents", () => {
    it("returns agents snapshot", async () => {
      const { status, body } = await apiGet("/snapshot/agents");
      expect(status).toBe(200);
      const b = body as { agents: Record<string, unknown> };
      expect(b.agents["claude"]).toBeDefined();
    });
  });

  describe("GET /snapshot/project", () => {
    it("returns project snapshot", async () => {
      const { status, body } = await apiGet("/snapshot/project");
      expect(status).toBe(200);
      const b = body as { project: { goal: string } };
      expect(b.project.goal).toBe("Test the API server");
    });
  });

  describe("GET /snapshot/stale", () => {
    it("returns staleness status", async () => {
      const { status, body } = await apiGet("/snapshot/stale");
      expect(status).toBe(200);
      const b = body as { wasStale: boolean };
      expect(typeof b.wasStale).toBe("boolean");
    });
  });

  // ── Task reconciliation ────────────────────────────────────────────────────

  describe("GET /tasks/:id/reconcile", () => {
    it("returns reconciliation instruction for a task", async () => {
      const { status, body } = await apiGet("/tasks/task_srv_001/reconcile");
      expect(status).toBe(200);
      const b = body as {
        taskId: string;
        taskStatus: string;
        instructions: string[];
      };
      expect(b.taskId).toBe("task_srv_001");
      expect(Array.isArray(b.instructions)).toBe(true);
      expect(b.instructions.length).toBeGreaterThan(0);
    });

    it("returns 404 for unknown task", async () => {
      const { status } = await apiGet("/tasks/definitely_not_real/reconcile");
      expect(status).toBe(404);
    });
  });

  // ── 404 handler ────────────────────────────────────────────────────────────

  describe("unknown routes", () => {
    it("returns 404 for unknown path", async () => {
      const { status } = await apiGet("/this/does/not/exist");
      expect(status).toBe(404);
    });
  });
});
