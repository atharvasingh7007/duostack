/**
 * __tests__/event-store.test.ts
 *
 * Tests for the core event store.
 * Every test uses a real temp directory — no mocks for file I/O.
 * This ensures Windows path handling and atomic write behavior are tested.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventStore, EventStore } from "../core/event-store.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), "duostack-test-"));
}

async function cleanupDir(dir: string): Promise<void> {
  await fsPromises.rm(dir, { recursive: true, force: true });
}

function makeProjectInitEvent() {
  return {
    eventType: "ProjectInitialized" as const,
    actor: "developer" as const,
    payload: {
      projectName: "test-project",
      projectPath: "/tmp/test",
      goal: "Build a test app",
      techStack: ["TypeScript", "Node.js"],
      stacklitVersion: "0.3.0",
      duostackVersion: "0.1.0",
    },
  };
}

function makeTaskCreatedEvent(taskId = "task_001") {
  return {
    eventType: "TaskCreated" as const,
    actor: "claude" as const,
    taskId,
    payload: {
      taskId,
      title: "Build auth module",
      description: "Implement JWT authentication",
      type: "build" as const,
      priority: "high" as const,
      primaryAgent: "antigravity" as const,
      fallbackAgent: "claude" as const,
      dependsOn: [],
      acceptanceCriteria: ["JWT middleware works", "Tests pass"],
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EventStore", () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    store = await createEventStore(tmpDir);
  });

  afterEach(async () => {
    await cleanupDir(tmpDir);
  });

  // ── Initialization ─────────────────────────────────────────────────────────

  describe("initialization", () => {
    it("creates events.jsonl if it does not exist", async () => {
      const eventsPath = path.join(tmpDir, "events.jsonl");
      expect(fs.existsSync(eventsPath)).toBe(true);
    });

    it("starts with version 0 on empty log", () => {
      expect(store.version).toBe(0);
    });

    it("counts existing events correctly on re-init", async () => {
      // Write 3 events
      await store.appendEvent(makeProjectInitEvent());
      await store.appendEvent(makeTaskCreatedEvent("task_001"));
      await store.appendEvent(makeTaskCreatedEvent("task_002"));

      // Create a new store instance pointing at the same dir
      const store2 = await createEventStore(tmpDir);
      expect(store2.version).toBe(3);
    });
  });

  // ── Append ─────────────────────────────────────────────────────────────────

  describe("appendEvent", () => {
    it("returns event with generated eventId and timestamp", async () => {
      const event = await store.appendEvent(makeProjectInitEvent());

      expect(event.eventId).toBeTruthy();
      expect(event.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(event.timestamp).toBeTruthy();
      expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
    });

    it("increments version counter on each append", async () => {
      expect(store.version).toBe(0);
      await store.appendEvent(makeProjectInitEvent());
      expect(store.version).toBe(1);
      await store.appendEvent(makeTaskCreatedEvent());
      expect(store.version).toBe(2);
    });

    it("writes valid JSON on each line", async () => {
      await store.appendEvent(makeProjectInitEvent());
      await store.appendEvent(makeTaskCreatedEvent());

      const eventsPath = path.join(tmpDir, "events.jsonl");
      const content = await fsPromises.readFile(eventsPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("sets schemaVersion to 1.0", async () => {
      const event = await store.appendEvent(makeProjectInitEvent());
      expect(event.schemaVersion).toBe("1.0");
    });

    it("preserves actor from input", async () => {
      const event = await store.appendEvent({
        eventType: "TaskCreated",
        actor: "claude",
        taskId: "task_001",
        payload: makeTaskCreatedEvent().payload,
      });
      expect(event.actor).toBe("claude");
    });

    it("generates correlationId if not provided", async () => {
      const event = await store.appendEvent(makeProjectInitEvent());
      expect(event.correlationId).toBeTruthy();
    });

    it("uses provided correlationId", async () => {
      const correlationId = "test-correlation-id-123";
      const event = await store.appendEvent({
        ...makeProjectInitEvent(),
        correlationId,
      });
      expect(event.correlationId).toBe(correlationId);
    });
  });

  // ── Batch append ───────────────────────────────────────────────────────────

  describe("appendEvents", () => {
    it("appends multiple events atomically under same correlationId", async () => {
      const sharedId = "shared-corr-id";
      const events = await store.appendEvents(
        [makeProjectInitEvent(), makeTaskCreatedEvent()],
        sharedId
      );

      expect(events).toHaveLength(2);
      expect(events[0]!.correlationId).toBe(sharedId);
      expect(events[1]!.correlationId).toBe(sharedId);
      expect(store.version).toBe(2);
    });

    it("generates shared correlationId if not provided", async () => {
      const events = await store.appendEvents([
        makeProjectInitEvent(),
        makeTaskCreatedEvent(),
      ]);

      expect(events[0]!.correlationId).toBe(events[1]!.correlationId);
    });
  });

  // ── Read ───────────────────────────────────────────────────────────────────

  describe("readEvents", () => {
    beforeEach(async () => {
      await store.appendEvent(makeProjectInitEvent());
      await store.appendEvent(makeTaskCreatedEvent("task_001"));
      await store.appendEvent(makeTaskCreatedEvent("task_002"));
    });

    it("reads all events in order", async () => {
      const events = await store.readAllEvents();
      expect(events).toHaveLength(3);
      expect(events[0]!.eventType).toBe("ProjectInitialized");
      expect(events[1]!.eventType).toBe("TaskCreated");
      expect(events[2]!.eventType).toBe("TaskCreated");
    });

    it("filters by taskId", async () => {
      const events = await store.readAllEvents({ taskId: "task_001" });
      expect(events).toHaveLength(1);
      expect(events[0]!.taskId).toBe("task_001");
    });

    it("filters by eventType", async () => {
      const events = await store.readAllEvents({
        eventTypes: ["TaskCreated"],
      });
      expect(events).toHaveLength(2);
    });

    it("filters by actor", async () => {
      const events = await store.readAllEvents({ actor: "developer" });
      expect(events).toHaveLength(1);
      expect(events[0]!.actor).toBe("developer");
    });
  });

  // ── readLastEvents ─────────────────────────────────────────────────────────

  describe("readLastEvents", () => {
    it("returns the last N events", async () => {
      for (let i = 0; i < 5; i++) {
        await store.appendEvent(makeTaskCreatedEvent(`task_00${i}`));
      }

      const last3 = await store.readLastEvents(3);
      expect(last3).toHaveLength(3);
      expect(last3[2]!.taskId).toBe("task_004");
    });

    it("returns all events if N > total", async () => {
      await store.appendEvent(makeProjectInitEvent());
      const events = await store.readLastEvents(100);
      expect(events).toHaveLength(1);
    });
  });

  // ── readTaskHistory ────────────────────────────────────────────────────────

  describe("readTaskHistory", () => {
    it("returns all events for a specific task", async () => {
      await store.appendEvent(makeProjectInitEvent());
      await store.appendEvent(makeTaskCreatedEvent("task_001"));
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
      await store.appendEvent(makeTaskCreatedEvent("task_002"));

      const history = await store.readTaskHistory("task_001");
      expect(history).toHaveLength(2);
      expect(history.every((e) => e.taskId === "task_001")).toBe(true);
    });
  });

  // ── readLatestOfType ───────────────────────────────────────────────────────

  describe("readLatestOfType", () => {
    it("returns the most recent event of a type", async () => {
      await store.appendEvent(makeTaskCreatedEvent("task_001"));
      await store.appendEvent(makeTaskCreatedEvent("task_002"));
      await store.appendEvent(makeTaskCreatedEvent("task_003"));

      const latest = await store.readLatestOfType("TaskCreated");
      expect(latest).not.toBeNull();
      expect(latest!.taskId).toBe("task_003");
    });

    it("returns null if no events of that type exist", async () => {
      const latest = await store.readLatestOfType("TaskCompleted");
      expect(latest).toBeNull();
    });
  });

  // ── Stats ──────────────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("returns correct event count and file size", async () => {
      await store.appendEvent(makeProjectInitEvent());
      await store.appendEvent(makeTaskCreatedEvent());

      const stats = await store.getStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.fileSizeBytes).toBeGreaterThan(0);
      expect(stats.eventsPath).toContain("events.jsonl");
    });
  });
});
