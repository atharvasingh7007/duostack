/**
 * __tests__/task-router.test.ts
 *
 * Tests for task routing logic.
 * Verifies that tasks go to the right agent under all health conditions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventStore } from "../core/event-store.js";
import { createSnapshotBuilder } from "../core/snapshot-builder.js";
import { createTaskRouter } from "../core/task-router.js";
import type { EventStore } from "../core/event-store.js";
import type { SnapshotBuilder } from "../core/snapshot-builder.js";
import type { TaskRouter } from "../core/task-router.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function setup(): Promise<{
  tmpDir: string;
  store: EventStore;
  builder: SnapshotBuilder;
  router: TaskRouter;
}> {
  const tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-router-test-")
  );
  const store = await createEventStore(tmpDir);
  const builder = createSnapshotBuilder(tmpDir, store);
  const router = createTaskRouter(builder);
  return { tmpDir, store, builder, router };
}

async function createTask(
  store: EventStore,
  taskId: string,
  type: string,
  priority = "normal",
  dependsOn: string[] = []
) {
  const primaryMap: Record<string, string> = {
    plan: "claude", design: "claude", architecture: "claude",
    review: "claude", integrate: "claude",
    build: "antigravity", test: "antigravity",
    verify: "antigravity", browser: "antigravity",
    refactor: "antigravity", debug: "claude",
  };
  const primary = primaryMap[type] ?? "claude";
  const fallback = primary === "claude" ? "antigravity" : "claude";

  await store.appendEvent({
    eventType: "TaskCreated",
    actor: "claude",
    taskId,
    payload: {
      taskId,
      title: `Task ${taskId}`,
      description: "desc",
      type: type as "build",
      priority: priority as "normal",
      primaryAgent: primary as "claude",
      fallbackAgent: fallback as "antigravity",
      dependsOn,
      acceptanceCriteria: [],
    },
  });
}

async function setAgentUnavailable(store: EventStore, agentId: string) {
  await store.appendEvent({
    eventType: "AgentUnavailableObserved",
    actor: "orchestrator",
    payload: {
      agentId: agentId as "antigravity",
      reason: "lease_expired_no_renewal",
      confidence: "high",
      estimatedRecoveryAt: null,
      failoverActivated: true,
      failoverTo: agentId === "antigravity" ? "claude" : "antigravity",
    },
  });
}

async function setAgentHealth(
  store: EventStore,
  agentId: string,
  health: string
) {
  await store.appendEvent({
    eventType: "AgentHealthUpdated",
    actor: agentId as "claude",
    payload: {
      agentId: agentId as "claude",
      previousHealth: "normal",
      newHealth: health,
      triggeredBy: "self_report",
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TaskRouter", () => {
  let tmpDir: string;
  let store: EventStore;
  let builder: SnapshotBuilder;
  let router: TaskRouter;

  beforeEach(async () => {
    ({ tmpDir, store, builder, router } = await setup());
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Primary routing ────────────────────────────────────────────────────────

  describe("primary routing", () => {
    it("routes build tasks to Antigravity when available", async () => {
      await createTask(store, "task_001", "build");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");

      expect(result).not.toBeNull();
      expect(result!.assignTo).toBe("antigravity");
      expect(result!.reason).toBe("primary_available");
      expect(result!.isInFallbackMode).toBe(false);
    });

    it("routes plan tasks to Claude when available", async () => {
      await createTask(store, "task_001", "plan");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");

      expect(result).not.toBeNull();
      expect(result!.assignTo).toBe("claude");
      expect(result!.reason).toBe("primary_available");
    });

    it("routes architecture tasks to Claude", async () => {
      await createTask(store, "task_001", "architecture");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");
      expect(result!.assignTo).toBe("claude");
    });

    it("routes test tasks to Antigravity", async () => {
      await createTask(store, "task_001", "test");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");
      expect(result!.assignTo).toBe("antigravity");
    });
  });

  // ── Fallback routing ───────────────────────────────────────────────────────

  describe("fallback routing", () => {
    it("routes to Claude when Antigravity is unavailable", async () => {
      await createTask(store, "task_001", "build");
      await setAgentUnavailable(store, "antigravity");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");

      expect(result).not.toBeNull();
      expect(result!.assignTo).toBe("claude");
      expect(result!.isInFallbackMode).toBe(true);
      expect(result!.reason).toBe("fallback_primary_exhausted");
    });

    it("routes to Antigravity when Claude is unavailable", async () => {
      await createTask(store, "task_001", "plan");
      await setAgentUnavailable(store, "claude");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");

      expect(result).not.toBeNull();
      expect(result!.assignTo).toBe("antigravity");
      expect(result!.isInFallbackMode).toBe(true);
    });

    it("returns blocked result when both agents unavailable", async () => {
      await createTask(store, "task_001", "build");
      await setAgentUnavailable(store, "antigravity");
      await setAgentUnavailable(store, "claude");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");
      expect(result!.reason).toBe("blocked_both_unavailable");
    });
  });

  // ── Token health routing ───────────────────────────────────────────────────

  describe("token health routing", () => {
    it("defers non-critical tasks in triage mode", async () => {
      await createTask(store, "task_001", "build", "normal");
      await setAgentHealth(store, "antigravity", "triage");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");

      expect(result!.reason).toBe("primary_in_triage_defer_non_critical");
    });

    it("routes critical tasks even in triage mode", async () => {
      await createTask(store, "task_001", "build", "critical");
      await setAgentHealth(store, "antigravity", "triage");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");

      expect(result!.reason).toBe("primary_available");
      expect(result!.assignTo).toBe("antigravity");
    });

    it("sets shouldBatch when agent is in batching mode", async () => {
      await createTask(store, "task_001", "build");
      await setAgentHealth(store, "antigravity", "batching");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");

      expect(result!.shouldBatch).toBe(true);
    });

    it("sets stacklit mode to derive_map under token pressure", async () => {
      await createTask(store, "task_001", "build");
      await setAgentHealth(store, "antigravity", "triage");
      await builder.rebuildAll();

      const result = await router.routeTask("task_001");

      // In triage mode the task is deferred for non-critical, but
      // if we force critical priority the mode should be derive_map
      await createTask(store, "task_002", "build", "critical");
      await builder.rebuildAll();

      const critResult = await router.routeTask("task_002");
      expect(critResult!.stacklitReadMode).toBe("derive_map");
    });
  });

  // ── Dependency checking ────────────────────────────────────────────────────

  describe("dependency checking", () => {
    it("does not route task with unsatisfied dependencies", async () => {
      await createTask(store, "task_001", "build");
      await createTask(store, "task_002", "build", "normal", ["task_001"]);
      await builder.rebuildAll();

      // task_001 is pending, so task_002 cannot be routed
      const result = await router.routeTask("task_002");
      expect(result).toBeNull();
    });

    it("routes task when dependency is completed", async () => {
      await createTask(store, "task_001", "build");
      await createTask(store, "task_002", "build", "normal", ["task_001"]);

      // Complete task_001
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
      // Need TaskStepPlanned to reach in_progress before completing
      await store.appendEvent({
        eventType: "TaskStepPlanned",
        actor: "antigravity",
        taskId: "task_001",
        payload: {
          stepId: "step_001",
          taskId: "task_001",
          stepNumber: 1,
          summary: "Build it",
          targetFiles: [],
          validation: [],
          nextActionIfSuccess: "done",
          nextActionIfFailure: "retry",
          isIdempotent: true,
          plannedBy: "antigravity",
        },
      });
      await store.appendEvent({
        eventType: "TaskCompleted",
        actor: "antigravity",
        taskId: "task_001",
        payload: {
          taskId: "task_001",
          completedBy: "antigravity",
          summary: "Done",
          artifacts: [],
          validationsPassed: [],
        },
      });

      await builder.rebuildAll();

      const result = await router.routeTask("task_002");
      expect(result).not.toBeNull();
      expect(result!.assignTo).toBe("antigravity");
    });
  });

  // ── Route all pending ──────────────────────────────────────────────────────

  describe("routeAllPending", () => {
    it("returns routing decisions in priority order", async () => {
      await createTask(store, "task_low", "build", "low");
      await createTask(store, "task_critical", "build", "critical");
      await createTask(store, "task_high", "build", "high");
      await builder.rebuildAll();

      const results = await router.routeAllPending();

      expect(results[0]!.taskId).toBe("task_critical");
      expect(results[1]!.taskId).toBe("task_high");
      expect(results[2]!.taskId).toBe("task_low");
    });

    it("excludes non-pending tasks", async () => {
      await createTask(store, "task_001", "build");
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
      await createTask(store, "task_002", "build");
      await builder.rebuildAll();

      const results = await router.routeAllPending();

      // Only task_002 should be routable — task_001 is claimed
      expect(results.some((r) => r.taskId === "task_001")).toBe(false);
      expect(results.some((r) => r.taskId === "task_002")).toBe(true);
    });
  });
});
