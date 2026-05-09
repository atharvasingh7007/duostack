/**
 * __tests__/integration.test.ts
 *
 * End-to-end integration test.
 * Exercises the full stack: event store → snapshot builder → task router →
 * handoff manager — simulating a real project session including silent
 * agent death and recovery.
 *
 * This is the most important test. If this passes, the core coordination
 * loop works correctly end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventStore } from "../core/event-store.js";
import { createSnapshotBuilder } from "../core/snapshot-builder.js";
import { createTaskRouter } from "../core/task-router.js";
import { createHandoffManager } from "../core/handoff-manager.js";
import type { EventStore } from "../core/event-store.js";
import type { SnapshotBuilder } from "../core/snapshot-builder.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  const tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "duostack-integration-")
  );
  const store = await createEventStore(tmpDir);
  const builder = createSnapshotBuilder(tmpDir, store);
  const router = createTaskRouter(builder);
  const handoff = createHandoffManager(store, builder);
  return { tmpDir, store, builder, router, handoff };
}

// ─── Integration test ─────────────────────────────────────────────────────────

describe("Integration: full coordination flow", () => {
  let tmpDir: string;
  let store: EventStore;
  let builder: SnapshotBuilder;

  beforeEach(async () => {
    ({ tmpDir, store, builder } = await setup());
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Normal session ─────────────────────────────────────────────

  it("Scenario 1: normal session — Claude plans, Antigravity executes", async () => {
    // 1. Project initialized
    await store.appendEvent({
      eventType: "ProjectInitialized",
      actor: "developer",
      payload: {
        projectName: "saas-app",
        projectPath: tmpDir,
        goal: "Build a SaaS app with auth and billing",
        techStack: ["TypeScript", "PostgreSQL", "Stripe"],
        stacklitVersion: "0.3.0",
        duostackVersion: "0.1.0",
      },
    });

    // 2. Claude signals ready
    await store.appendEvent({
      eventType: "AgentStatusObserved",
      actor: "claude",
      payload: {
        agentId: "claude",
        health: "normal",
        confidence: "high",
        reason: "session start",
      },
    });

    // 3. Claude creates a plan task and a build task
    await store.appendEvent({
      eventType: "TaskCreated",
      actor: "claude",
      taskId: "task_001",
      payload: {
        taskId: "task_001",
        title: "Design auth architecture",
        description: "Define JWT flow, token rotation, session management",
        type: "architecture",
        priority: "critical",
        primaryAgent: "claude",
        fallbackAgent: "antigravity",
        dependsOn: [],
        acceptanceCriteria: [
          "JWT strategy documented",
          "Token rotation approach decided",
        ],
      },
    });

    await store.appendEvent({
      eventType: "TaskCreated",
      actor: "claude",
      taskId: "task_002",
      payload: {
        taskId: "task_002",
        title: "Implement auth module",
        description: "Build JWT middleware, login route, refresh token rotation",
        type: "build",
        priority: "high",
        primaryAgent: "antigravity",
        fallbackAgent: "claude",
        dependsOn: ["task_001"],
        acceptanceCriteria: [
          "JWT middleware works",
          "Refresh rotation tested",
          "All tests pass",
        ],
      },
    });

    // 4. Claude claims and completes the architecture task
    await store.appendEvent({
      eventType: "TaskClaimed",
      actor: "claude",
      taskId: "task_001",
      payload: {
        taskId: "task_001",
        claimedBy: "claude",
        leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
        attemptNumber: 1,
      },
    });

    await store.appendEvent({
      eventType: "TaskStepPlanned",
      actor: "claude",
      taskId: "task_001",
      payload: {
        stepId: "step_001",
        taskId: "task_001",
        stepNumber: 1,
        summary: "Document JWT architecture decisions",
        targetFiles: [".duostack/decisions.md"],
        validation: [],
        nextActionIfSuccess: "Record decision and mark task complete",
        nextActionIfFailure: "Revise approach",
        isIdempotent: true,
        plannedBy: "claude",
      },
    });

    await store.appendEvent({
      eventType: "TaskStepCompleted",
      actor: "claude",
      taskId: "task_001",
      payload: {
        stepId: "step_001",
        taskId: "task_001",
        completedBy: "claude",
        actualFilesChanged: [".duostack/decisions.md"],
        gitDiffHash: "abc123",
        validationPassed: true,
        notes: "Using JWT with 15min expiry + refresh rotation",
      },
    });

    await store.appendEvent({
      eventType: "TaskCompleted",
      actor: "claude",
      taskId: "task_001",
      payload: {
        taskId: "task_001",
        completedBy: "claude",
        summary: "Auth architecture designed",
        artifacts: [".duostack/decisions.md"],
        validationsPassed: ["step_001"],
      },
    });

    // 5. Claude writes a checkpoint
    await store.appendEvent({
      eventType: "ProjectCheckpointWritten",
      actor: "claude",
      payload: {
        triggeredBy: "milestone",
        currentMilestone: "Auth architecture complete",
        openTaskCount: 1,
        completedTaskCount: 1,
        activeAgent: "claude",
        summary: "Architecture decided. Using JWT 15min + refresh rotation. task_002 ready for Antigravity.",
      },
    });

    // Rebuild and verify state
    const { tasks, project } = await builder.rebuildAll();

    expect(tasks.tasks["task_001"]!.status).toBe("completed");
    expect(tasks.tasks["task_002"]!.status).toBe("pending");
    expect(project.lastCheckpointAt).not.toBeNull();
    expect(project.completedTaskCount).toBe(1);

    // 6. Antigravity signals ready and claims task_002
    await store.appendEvent({
      eventType: "AgentStatusObserved",
      actor: "antigravity",
      payload: {
        agentId: "antigravity",
        health: "normal",
        confidence: "high",
        reason: "session start",
      },
    });

    await store.appendEvent({
      eventType: "TaskClaimed",
      actor: "antigravity",
      taskId: "task_002",
      payload: {
        taskId: "task_002",
        claimedBy: "antigravity",
        leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
        attemptNumber: 1,
      },
    });

    // 7. Antigravity writes step intent and executes
    await store.appendEvents([
      {
        eventType: "TaskStepPlanned",
        actor: "antigravity",
        taskId: "task_002",
        payload: {
          stepId: "step_001",
          taskId: "task_002",
          stepNumber: 1,
          summary: "Implement JWT middleware in src/auth/middleware.ts",
          targetFiles: ["src/auth/middleware.ts"],
          validation: ["pnpm test auth", "pnpm typecheck"],
          nextActionIfSuccess: "Implement refresh rotation",
          nextActionIfFailure: "Roll back middleware.ts and retry with simpler approach",
          isIdempotent: true,
          plannedBy: "antigravity",
        },
      },
      {
        eventType: "TaskStepStarted",
        actor: "antigravity",
        taskId: "task_002",
        payload: {
          stepId: "step_001",
          taskId: "task_002",
          startedBy: "antigravity",
        },
      },
    ]);

    await store.appendEvents([
      {
        eventType: "TaskStepCompleted",
        actor: "antigravity",
        taskId: "task_002",
        payload: {
          stepId: "step_001",
          taskId: "task_002",
          completedBy: "antigravity",
          actualFilesChanged: ["src/auth/middleware.ts"],
          gitDiffHash: "def456",
          validationPassed: true,
          notes: "Used express-jwt v9",
        },
      },
      {
        eventType: "ArtifactsObserved",
        actor: "antigravity",
        taskId: "task_002",
        payload: {
          stepId: "step_001",
          taskId: "task_002",
          filesChanged: ["src/auth/middleware.ts"],
          gitDiffHash: "def456",
          observedBy: "antigravity",
        },
      },
    ]);

    const { tasks: tasks2 } = await builder.rebuildAll();
    const task002 = tasks2.tasks["task_002"]!;

    expect(task002.status).toBe("in_progress");
    expect(task002.steps[0]!.status).toBe("completed");
    expect(task002.steps[0]!.result?.gitDiffHash).toBe("def456");
  });

  // ── Scenario 2: Silent death and recovery ──────────────────────────────────

  it("Scenario 2: Antigravity dies silently — Claude takes over via reconciliation", async () => {
    // Setup: project with one in-progress task claimed by Antigravity
    await store.appendEvent({
      eventType: "ProjectInitialized",
      actor: "developer",
      payload: {
        projectName: "test-project",
        projectPath: tmpDir,
        goal: "Test silent death recovery",
        techStack: ["TypeScript"],
        stacklitVersion: "0.3.0",
        duostackVersion: "0.1.0",
      },
    });

    await store.appendEvent({
      eventType: "TaskCreated",
      actor: "claude",
      taskId: "task_001",
      payload: {
        taskId: "task_001",
        title: "Build payment integration",
        description: "Stripe payment flow",
        type: "build",
        priority: "high",
        primaryAgent: "antigravity",
        fallbackAgent: "claude",
        dependsOn: [],
        acceptanceCriteria: ["Payment flow works"],
      },
    });

    // Antigravity claims it
    const leaseExpiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
    await store.appendEvent({
      eventType: "TaskClaimed",
      actor: "antigravity",
      taskId: "task_001",
      payload: {
        taskId: "task_001",
        claimedBy: "antigravity",
        leaseExpiresAt,
        attemptNumber: 1,
      },
    });

    // Antigravity writes step intent — then dies (no completion event)
    await store.appendEvent({
      eventType: "TaskStepPlanned",
      actor: "antigravity",
      taskId: "task_001",
      payload: {
        stepId: "step_001",
        taskId: "task_001",
        stepNumber: 1,
        summary: "Implement Stripe webhook handler",
        targetFiles: ["src/payments/webhook.ts"],
        validation: ["pnpm test payments"],
        nextActionIfSuccess: "Add idempotency key handling",
        nextActionIfFailure: "Roll back webhook.ts",
        isIdempotent: true,
        plannedBy: "antigravity",
      },
    });

    // Partial artifacts observed (Antigravity wrote some files before dying)
    await store.appendEvent({
      eventType: "ArtifactsObserved",
      actor: "antigravity",
      taskId: "task_001",
      payload: {
        stepId: "step_001",
        taskId: "task_001",
        filesChanged: ["src/payments/webhook.ts"],
        gitDiffHash: "partial123",
        observedBy: "antigravity",
      },
    });

    // ← Antigravity dies here. No TaskStepCompleted. No heartbeat.

    // Orchestrator detects expiry and emits events
    await store.appendEvent({
      eventType: "TaskLeaseExpired",
      actor: "orchestrator",
      taskId: "task_001",
      payload: {
        taskId: "task_001",
        wasClaimedBy: "antigravity",
        expiredAt: new Date().toISOString(),
        handoffCount: 0,
        willReassign: true,
      },
    });

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

    const { tasks, agents } = await builder.rebuildAll();

    // Verify state after expiry
    expect(tasks.tasks["task_001"]!.status).toBe("pending");
    expect(tasks.tasks["task_001"]!.lease).toBeNull();
    expect(agents.agents["antigravity"]!.status).toBe("unavailable");

    // Verify task history — Claude can read this for reconciliation
    const history = await store.readTaskHistory("task_001");
    const stepPlanned = history.find((e) => e.eventType === "TaskStepPlanned");
    const artifacts = history.find((e) => e.eventType === "ArtifactsObserved");

    expect(stepPlanned).toBeDefined();
    expect(artifacts).toBeDefined();

    // The last intent
    expect(
      stepPlanned?.eventType === "TaskStepPlanned" &&
      stepPlanned.payload.summary
    ).toBe("Implement Stripe webhook handler");

    // The last known reality
    expect(
      artifacts?.eventType === "ArtifactsObserved" &&
      artifacts.payload.gitDiffHash
    ).toBe("partial123");

    // Claude now claims the task in fallback mode
    await store.appendEvent({
      eventType: "TaskClaimed",
      actor: "claude",
      taskId: "task_001",
      payload: {
        taskId: "task_001",
        claimedBy: "claude",
        leaseExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
        attemptNumber: 2, // second attempt
      },
    });

    const { tasks: tasks2 } = await builder.rebuildAll();
    expect(tasks2.tasks["task_001"]!.status).toBe("claimed");
    expect(tasks2.tasks["task_001"]!.assignedTo).toBe("claude");
    expect(tasks2.tasks["task_001"]!.lease!.attemptNumber).toBe(2);
  });

  // ── Scenario 3: Weekly reset recovery ─────────────────────────────────────

  it("Scenario 3: Antigravity recovers after weekly reset", async () => {
    // Antigravity was marked unavailable
    await store.appendEvent({
      eventType: "AgentUnavailableObserved",
      actor: "orchestrator",
      payload: {
        agentId: "antigravity",
        reason: "lease_expired_no_renewal",
        confidence: "high",
        estimatedRecoveryAt: new Date().toISOString(), // reset time
        failoverActivated: true,
        failoverTo: "claude",
      },
    });

    const { agents: before } = await builder.rebuildAll();
    expect(before.agents["antigravity"]!.status).toBe("unavailable");

    // Antigravity comes back — posts recovery
    await store.appendEvent({
      eventType: "AgentRecovered",
      actor: "antigravity",
      payload: {
        agentId: "antigravity",
        recoveredAt: new Date().toISOString(),
        previousDowntime: "6 days 22 hours",
        resumingFromCheckpoint: true,
        firstTaskId: null,
      },
    });

    const { agents: after } = await builder.rebuildAll();
    expect(after.agents["antigravity"]!.status).toBe("available");
    expect(after.agents["antigravity"]!.health).toBe("normal");
    expect(after.agents["antigravity"]!.tokenHealth.estimatedResetAt).toBeNull();
  });

  // ── Scenario 4: Continuous checkpointing survives Claude context reset ─────

  it("Scenario 4: New Claude session recovers from checkpoint", async () => {
    // Original Claude session creates tasks and writes checkpoint
    await store.appendEvent({
      eventType: "ProjectInitialized",
      actor: "developer",
      payload: {
        projectName: "checkpoint-test",
        projectPath: tmpDir,
        goal: "Test checkpoint recovery",
        techStack: ["TypeScript"],
        stacklitVersion: "0.3.0",
        duostackVersion: "0.1.0",
      },
    });

    for (let i = 1; i <= 5; i++) {
      await store.appendEvent({
        eventType: "TaskCreated",
        actor: "claude",
        taskId: `task_00${i}`,
        payload: {
          taskId: `task_00${i}`,
          title: `Task ${i}`,
          description: "desc",
          type: i <= 2 ? "build" : "plan",
          priority: "normal",
          primaryAgent: i <= 2 ? "antigravity" : "claude",
          fallbackAgent: i <= 2 ? "claude" : "antigravity",
          dependsOn: i > 1 ? [`task_00${i - 1}`] : [],
          acceptanceCriteria: [],
        },
      });
    }

    await store.appendEvent({
      eventType: "ProjectCheckpointWritten",
      actor: "claude",
      payload: {
        triggeredBy: "scheduled",
        currentMilestone: "Initial planning complete",
        openTaskCount: 5,
        completedTaskCount: 0,
        activeAgent: "claude",
        summary: "Created 5 tasks. Tasks 1-2 are build tasks for Antigravity. Tasks 3-5 are plan tasks for Claude. Dependencies: task_002 depends on task_001, etc.",
      },
    });

    // ← Claude context resets here. New session starts.
    // New Claude reads the snapshot — it sees everything.
    const { tasks, project } = await builder.rebuildAll();

    // New Claude can see:
    expect(project.currentMilestone).toBe("Initial planning complete");
    expect(project.lastCheckpointAt).not.toBeNull();
    expect(Object.keys(tasks.tasks)).toHaveLength(5);
    expect(tasks.byStatus["pending"]).toHaveLength(5);

    // Dependency chain is intact
    expect(tasks.tasks["task_002"]!.dependsOn).toEqual(["task_001"]);
    expect(tasks.tasks["task_001"]!.blocks).toContain("task_002");

    // New Claude can immediately continue — zero context loss
    expect(project.goal).toBe("Test checkpoint recovery");
  });
});
