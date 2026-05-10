/**
 * __tests__/snapshot-builder.test.ts
 *
 * Tests for snapshot builder — verifies that event replay
 * produces correct derived state for all key event sequences.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventStore } from "../core/event-store.js";
import { createSnapshotBuilder } from "../core/snapshot-builder.js";
import type { EventStore } from "../core/event-store.js";
import type { SnapshotBuilder } from "../core/snapshot-builder.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), "duostack-snap-test-"));
}

async function setup(): Promise<{
  tmpDir: string;
  store: EventStore;
  builder: SnapshotBuilder;
}> {
  const tmpDir = await makeTempDir();
  const store = await createEventStore(tmpDir);
  const builder = createSnapshotBuilder(tmpDir, store);
  return { tmpDir, store, builder };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SnapshotBuilder", () => {
  let tmpDir: string;
  let store: EventStore;
  let builder: SnapshotBuilder;

  beforeEach(async () => {
    ({ tmpDir, store, builder } = await setup());
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Project init ───────────────────────────────────────────────────────────

  describe("ProjectInitialized", () => {
    it("populates project snapshot fields", async () => {
      await store.appendEvent({
        eventType: "ProjectInitialized",
        actor: "developer",
        payload: {
          projectName: "my-app",
          projectPath: "/projects/my-app",
          goal: "Build a SaaS app",
          techStack: ["TypeScript", "Postgres"],
          stacklitVersion: "0.3.0",
          duostackVersion: "0.1.0",
        },
      });

      const { project } = await builder.rebuildAll();

      expect(project.projectName).toBe("my-app");
      expect(project.goal).toBe("Build a SaaS app");
      expect(project.techStack).toEqual(["TypeScript", "Postgres"]);
    });
  });

  // ── Task lifecycle ─────────────────────────────────────────────────────────

  describe("task lifecycle", () => {
    const taskId = "task_001";

    async function createTask(): Promise<void> {
      await store.appendEvent({
        eventType: "TaskCreated",
        actor: "claude",
        taskId,
        payload: {
          taskId,
          title: "Build auth",
          description: "JWT auth",
          type: "build",
          priority: "high",
          primaryAgent: "antigravity",
          fallbackAgent: "claude",
          dependsOn: [],
          acceptanceCriteria: ["Tests pass"],
        },
      });
    }

    it("creates task in pending status", async () => {
      await createTask();
      const { tasks } = await builder.rebuildAll();

      expect(tasks.tasks[taskId]).toBeDefined();
      expect(tasks.tasks[taskId]!.status).toBe("pending");
      expect(tasks.byStatus["pending"]).toContain(taskId);
    });

    it("transitions pending → claimed on TaskClaimed", async () => {
      await createTask();
      await store.appendEvent({
        eventType: "TaskClaimed",
        actor: "antigravity",
        taskId,
        payload: {
          taskId,
          claimedBy: "antigravity",
          leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
          attemptNumber: 1,
        },
      });

      const { tasks } = await builder.rebuildAll();

      expect(tasks.tasks[taskId]!.status).toBe("claimed");
      expect(tasks.tasks[taskId]!.assignedTo).toBe("antigravity");
      expect(tasks.tasks[taskId]!.lease).not.toBeNull();
      expect(tasks.byStatus["claimed"]).toContain(taskId);
    });

    it("transitions to in_progress on TaskStepPlanned", async () => {
      await createTask();
      await store.appendEvent({
        eventType: "TaskClaimed",
        actor: "antigravity",
        taskId,
        payload: {
          taskId,
          claimedBy: "antigravity",
          leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
          attemptNumber: 1,
        },
      });
      await store.appendEvent({
        eventType: "TaskStepPlanned",
        actor: "antigravity",
        taskId,
        payload: {
          stepId: "step_001",
          taskId,
          stepNumber: 1,
          summary: "Implement JWT middleware",
          targetFiles: ["src/auth/middleware.ts"],
          validation: ["pnpm test auth"],
          nextActionIfSuccess: "Add refresh rotation",
          nextActionIfFailure: "Roll back and retry",
          isIdempotent: true,
          plannedBy: "antigravity",
        },
      });

      const { tasks } = await builder.rebuildAll();

      expect(tasks.tasks[taskId]!.status).toBe("in_progress");
      expect(tasks.tasks[taskId]!.steps).toHaveLength(1);
      expect(tasks.tasks[taskId]!.steps[0]!.status).toBe("planned");
    });

    it("marks task completed", async () => {
      await createTask();
      await store.appendEvent({
        eventType: "TaskClaimed",
        actor: "antigravity",
        taskId,
        payload: {
          taskId,
          claimedBy: "antigravity",
          leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
          attemptNumber: 1,
        },
      });
      // Must transition through in_progress first
      await store.appendEvent({
        eventType: "TaskStepPlanned",
        actor: "antigravity",
        taskId,
        payload: {
          stepId: "step_001",
          taskId,
          stepNumber: 1,
          summary: "Implement middleware",
          targetFiles: ["src/auth/middleware.ts"],
          validation: ["pnpm test"],
          nextActionIfSuccess: "done",
          nextActionIfFailure: "retry",
          isIdempotent: true,
          plannedBy: "antigravity",
        },
      });
      await store.appendEvent({
        eventType: "TaskCompleted",
        actor: "antigravity",
        taskId,
        payload: {
          taskId,
          completedBy: "antigravity",
          summary: "Auth module complete",
          artifacts: ["src/auth/middleware.ts"],
          validationsPassed: ["step_001"],
        },
      });

      const { tasks } = await builder.rebuildAll();

      expect(tasks.tasks[taskId]!.status).toBe("completed");
      expect(tasks.tasks[taskId]!.completedAt).not.toBeNull();
      expect(tasks.tasks[taskId]!.lease).toBeNull();
      expect(tasks.byStatus["completed"]).toContain(taskId);
    });

    it("handles lease expiry and reassignment", async () => {
      await createTask();
      await store.appendEvent({
        eventType: "TaskClaimed",
        actor: "antigravity",
        taskId,
        payload: {
          taskId,
          claimedBy: "antigravity",
          leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
          attemptNumber: 1,
        },
      });
      await store.appendEvent({
        eventType: "TaskLeaseExpired",
        actor: "orchestrator",
        taskId,
        payload: {
          taskId,
          wasClaimedBy: "antigravity",
          expiredAt: new Date().toISOString(),
          handoffCount: 0,
          willReassign: true,
        },
      });

      const { tasks } = await builder.rebuildAll();

      expect(tasks.tasks[taskId]!.status).toBe("pending");
      expect(tasks.tasks[taskId]!.lease).toBeNull();
    });
  });

  // ── Agent health ───────────────────────────────────────────────────────────

  describe("agent health", () => {
    it("marks agent unavailable on AgentUnavailableObserved", async () => {
      await store.appendEvent({
        eventType: "AgentUnavailableObserved",
        actor: "orchestrator",
        payload: {
          agentId: "antigravity",
          reason: "lease_expired_no_renewal",
          confidence: "high",
          estimatedRecoveryAt: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000
          ).toISOString(),
          failoverActivated: true,
          failoverTo: "claude",
        },
      });

      const { agents } = await builder.rebuildAll();

      expect(agents.agents["antigravity"]!.status).toBe("unavailable");
      expect(agents.agents["antigravity"]!.health).toBe("exhausted");
    });

    it("marks agent available on AgentRecovered", async () => {
      await store.appendEvent({
        eventType: "AgentUnavailableObserved",
        actor: "orchestrator",
        payload: {
          agentId: "antigravity",
          reason: "lease_expired_no_renewal",
          confidence: "high",
          estimatedRecoveryAt: null,
          failoverActivated: false,
          failoverTo: null,
        },
      });
      await store.appendEvent({
        eventType: "AgentRecovered",
        actor: "antigravity",
        payload: {
          agentId: "antigravity",
          recoveredAt: new Date().toISOString(),
          previousDowntime: "6 days 4 hours",
          resumingFromCheckpoint: true,
          firstTaskId: null,
        },
      });

      const { agents } = await builder.rebuildAll();

      expect(agents.agents["antigravity"]!.status).toBe("available");
      expect(agents.agents["antigravity"]!.health).toBe("normal");
    });
  });

  // ── Derived indexes ────────────────────────────────────────────────────────

  describe("derived indexes", () => {
    it("builds byStatus index correctly", async () => {
      await store.appendEvent({
        eventType: "TaskCreated",
        actor: "claude",
        taskId: "task_001",
        payload: {
          taskId: "task_001",
          title: "Task 1",
          description: "desc",
          type: "build",
          priority: "high",
          primaryAgent: "antigravity",
          fallbackAgent: "claude",
          dependsOn: [],
          acceptanceCriteria: [],
        },
      });
      await store.appendEvent({
        eventType: "TaskCreated",
        actor: "claude",
        taskId: "task_002",
        payload: {
          taskId: "task_002",
          title: "Task 2",
          description: "desc",
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
        actor: "antigravity",
        taskId: "task_001",
        payload: {
          taskId: "task_001",
          claimedBy: "antigravity",
          leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
          attemptNumber: 1,
        },
      });

      const { tasks } = await builder.rebuildAll();

      expect(tasks.byStatus["claimed"]).toContain("task_001");
      expect(tasks.byStatus["pending"]).toContain("task_002");
      expect(tasks.byAgent["antigravity"]).toContain("task_001");
    });

    it("builds blocks index from dependsOn", async () => {
      await store.appendEvent({
        eventType: "TaskCreated",
        actor: "claude",
        taskId: "task_001",
        payload: {
          taskId: "task_001",
          title: "Foundation",
          description: "desc",
          type: "build",
          priority: "high",
          primaryAgent: "antigravity",
          fallbackAgent: "claude",
          dependsOn: [],
          acceptanceCriteria: [],
        },
      });
      await store.appendEvent({
        eventType: "TaskCreated",
        actor: "claude",
        taskId: "task_002",
        payload: {
          taskId: "task_002",
          title: "Depends on foundation",
          description: "desc",
          type: "build",
          priority: "normal",
          primaryAgent: "antigravity",
          fallbackAgent: "claude",
          dependsOn: ["task_001"],
          acceptanceCriteria: [],
        },
      });

      const { tasks } = await builder.rebuildAll();

      expect(tasks.tasks["task_001"]!.blocks).toContain("task_002");
      expect(tasks.criticalPath).toContain("task_001");
    });
  });

  // ── Staleness ──────────────────────────────────────────────────────────────

  describe("isStale", () => {
    it("returns true before first rebuild", async () => {
      await store.appendEvent({
        eventType: "ProjectInitialized",
        actor: "developer",
        payload: {
          projectName: "test",
          projectPath: "/tmp",
          goal: "test",
          techStack: [],
          stacklitVersion: "0.3.0",
          duostackVersion: "0.1.0",
        },
      });

      const stale = await builder.isStale();
      expect(stale).toBe(true);
    });

    it("returns false immediately after rebuild", async () => {
      await store.appendEvent({
        eventType: "ProjectInitialized",
        actor: "developer",
        payload: {
          projectName: "test",
          projectPath: "/tmp",
          goal: "test",
          techStack: [],
          stacklitVersion: "0.3.0",
          duostackVersion: "0.1.0",
        },
      });

      await builder.rebuildAll();
      const stale = await builder.isStale();
      expect(stale).toBe(false);
    });

    it("returns true after new event appended post-rebuild", async () => {
      await store.appendEvent({
        eventType: "ProjectInitialized",
        actor: "developer",
        payload: {
          projectName: "test",
          projectPath: "/tmp",
          goal: "test",
          techStack: [],
          stacklitVersion: "0.3.0",
          duostackVersion: "0.1.0",
        },
      });
      await builder.rebuildAll();

      // Append new event after rebuild
      await store.appendEvent({
        eventType: "TaskCreated",
        actor: "claude",
        taskId: "task_001",
        payload: {
          taskId: "task_001",
          title: "New task",
          description: "desc",
          type: "build",
          priority: "high",
          primaryAgent: "antigravity",
          fallbackAgent: "claude",
          dependsOn: [],
          acceptanceCriteria: [],
        },
      });

      const stale = await builder.isStale();
      expect(stale).toBe(true);
    });
  });
});
