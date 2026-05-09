/**
 * __tests__/efficiency-tracker.test.ts
 *
 * Tests for the efficiency tracker — waste detection and reporting.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventStore } from "../core/event-store.js";
import { createEfficiencyTracker } from "../core/efficiency-tracker.js";
import { defaultConfig } from "../core/config.js";
import type { EventStore } from "../core/event-store.js";

async function setup() {
  const tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-efficiency-test-")
  );
  const store = await createEventStore(tmpDir);
  const config = defaultConfig(tmpDir);
  config.stateDir = tmpDir;
  config.efficiency.logPath = path.join(tmpDir, "efficiency.json");
  const tracker = createEfficiencyTracker(store, config);
  return { tmpDir, store, tracker, config };
}

async function createAndClaimTask(
  store: EventStore,
  taskId: string,
  type = "build"
) {
  await store.appendEvent({
    eventType: "TaskCreated",
    actor: "claude",
    taskId,
    payload: {
      taskId,
      title: `Task ${taskId}`,
      description: "desc",
      type: type as "build",
      priority: "normal",
      primaryAgent: "antigravity",
      fallbackAgent: "claude",
      dependsOn: [],
      acceptanceCriteria: [],
    },
  });
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
}

describe("EfficiencyTracker", () => {
  let tmpDir: string;
  let store: EventStore;
  let tracker: ReturnType<typeof createEfficiencyTracker>;

  beforeEach(async () => {
    ({ tmpDir, store, tracker } = await setup());
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Basic report ───────────────────────────────────────────────────────────

  describe("generateReport", () => {
    it("generates a report with correct structure", async () => {
      await createAndClaimTask(store, "task_001");

      const report = await tracker.generateReport();

      expect(report.generatedAt).toBeTruthy();
      expect(report.byAgent).toHaveProperty("claude");
      expect(report.byAgent).toHaveProperty("antigravity");
      expect(report.byTaskType).toBeDefined();
      expect(Array.isArray(report.wasteEvents)).toBe(true);
      expect(Array.isArray(report.recommendations)).toBe(true);
    });

    it("counts completed tasks per agent", async () => {
      await createAndClaimTask(store, "task_001");
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

      const report = await tracker.generateReport();
      expect(report.byAgent["antigravity"]!.tasksCompleted).toBe(1);
    });

    it("writes report to efficiency.json", async () => {
      await createAndClaimTask(store, "task_001");
      await tracker.generateReport();

      const config = defaultConfig(tmpDir);
      config.efficiency.logPath = path.join(tmpDir, "efficiency.json");
      const exists = await fsPromises
        .stat(config.efficiency.logPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });
  });

  // ── Waste detection ────────────────────────────────────────────────────────

  describe("waste detection", () => {
    it("detects missing step plan", async () => {
      await createAndClaimTask(store, "task_001");

      // TaskStepStarted without preceding TaskStepPlanned for same stepId
      await store.appendEvent({
        eventType: "TaskStepStarted",
        actor: "antigravity",
        taskId: "task_001",
        payload: {
          stepId: "step_unplanned",
          taskId: "task_001",
          startedBy: "antigravity",
        },
      });

      const report = await tracker.generateReport();
      const waste = report.wasteEvents.find(
        (w) => w.type === "missing_step_plan"
      );

      expect(waste).toBeDefined();
      expect(waste!.impact).toBe("high");
    });

    it("does not flag step started after step planned", async () => {
      await createAndClaimTask(store, "task_001");

      const stepId = "step_001";
      await store.appendEvent({
        eventType: "TaskStepPlanned",
        actor: "antigravity",
        taskId: "task_001",
        payload: {
          stepId,
          taskId: "task_001",
          stepNumber: 1,
          summary: "Build",
          targetFiles: [],
          validation: [],
          nextActionIfSuccess: "done",
          nextActionIfFailure: "retry",
          isIdempotent: true,
          plannedBy: "antigravity",
        },
      });
      await store.appendEvent({
        eventType: "TaskStepStarted",
        actor: "antigravity",
        taskId: "task_001",
        payload: {
          stepId,
          taskId: "task_001",
          startedBy: "antigravity",
        },
      });

      const report = await tracker.generateReport();
      const waste = report.wasteEvents.find(
        (w) => w.type === "missing_step_plan"
      );

      expect(waste).toBeUndefined();
    });

    it("detects handoff loop", async () => {
      await createAndClaimTask(store, "task_001");

      // 3 handoffs for same task
      for (let i = 0; i < 3; i++) {
        await store.appendEvent({
          eventType: "TaskHandedOff",
          actor: "antigravity",
          taskId: "task_001",
          payload: {
            taskId: "task_001",
            handoff: {
              fromAgent: "antigravity",
              toAgent: "claude",
              triggeredBy: "exhaustion",
              handedOffAt: new Date().toISOString(),
              summary: "Handoff",
              completedStepIds: [],
              artifactsProduced: [],
              lastCompletedStepId: null,
              nextStepSummary: "Continue",
              nextTargetFiles: [],
              nextValidation: [],
              contextForFallback: "context",
              openQuestions: [],
              doNotTouch: [],
            },
          },
        });
      }

      const report = await tracker.generateReport();
      const loop = report.wasteEvents.find((w) => w.type === "handoff_loop");

      expect(loop).toBeDefined();
      expect(loop!.impact).toBe("high");
    });

    it("detects high attempt count", async () => {
      await createAndClaimTask(store, "task_001");

      // Claim 4 more times (total 5 attempts)
      for (let attempt = 2; attempt <= 5; attempt++) {
        await store.appendEvent({
          eventType: "TaskClaimed",
          actor: "antigravity",
          taskId: "task_001",
          payload: {
            taskId: "task_001",
            claimedBy: "antigravity",
            leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
            attemptNumber: attempt,
          },
        });
      }

      const report = await tracker.generateReport();
      const highAttempt = report.wasteEvents.find(
        (w) => w.type === "high_attempt_count"
      );

      expect(highAttempt).toBeDefined();
    });

    it("detects checkpoint skipped after many decisions", async () => {
      // 6 decisions without a checkpoint
      for (let i = 1; i <= 6; i++) {
        await store.appendEvent({
          eventType: "DecisionRecorded",
          actor: "claude",
          payload: {
            decisionId: `D-2026-01-01-00${i}`,
            title: `Decision ${i}`,
            decision: "Decided something",
            rationale: "Because",
            constraints: [],
            status: "FINAL",
            doNotReEvaluate: true,
          },
        });
      }

      // Then a checkpoint (which triggers the detection)
      await store.appendEvent({
        eventType: "ProjectCheckpointWritten",
        actor: "claude",
        payload: {
          triggeredBy: "scheduled",
          currentMilestone: "M1",
          openTaskCount: 0,
          completedTaskCount: 0,
          activeAgent: "claude",
          summary: "checkpoint",
        },
      });

      const report = await tracker.generateReport();
      const skipped = report.wasteEvents.find(
        (w) => w.type === "checkpoint_skipped"
      );

      expect(skipped).toBeDefined();
      expect(skipped!.impact).toBe("medium");
    });
  });

  // ── Task type analysis ─────────────────────────────────────────────────────

  describe("task type analysis", () => {
    it("tracks completion by primary vs fallback", async () => {
      // Task completed by primary (antigravity for build)
      await createAndClaimTask(store, "task_001", "build");
      await store.appendEvent({
        eventType: "TaskStepPlanned",
        actor: "antigravity",
        taskId: "task_001",
        payload: {
          stepId: "s1", taskId: "task_001", stepNumber: 1,
          summary: "build", targetFiles: [], validation: [],
          nextActionIfSuccess: "done", nextActionIfFailure: "retry",
          isIdempotent: true, plannedBy: "antigravity",
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

      const report = await tracker.generateReport();
      const buildStats = report.byTaskType["build"];

      expect(buildStats).toBeDefined();
      expect(buildStats!.completedByPrimary).toBe(1);
      expect(buildStats!.completedByFallback).toBe(0);
    });
  });

  // ── Recommendations ────────────────────────────────────────────────────────

  describe("recommendations", () => {
    it("includes positive message when no waste detected", async () => {
      const report = await tracker.generateReport();
      expect(report.recommendations[0]).toContain("efficiently");
    });

    it("includes recommendation for missing step plans", async () => {
      await createAndClaimTask(store, "task_001");
      await store.appendEvent({
        eventType: "TaskStepStarted",
        actor: "antigravity",
        taskId: "task_001",
        payload: {
          stepId: "unplanned",
          taskId: "task_001",
          startedBy: "antigravity",
        },
      });

      const report = await tracker.generateReport();
      expect(
        report.recommendations.some((r) => r.includes("ds_plan_step"))
      ).toBe(true);
    });
  });
});
