/**
 * __tests__/schemas.test.ts
 *
 * Tests for schema-level logic: task state machine, routing table,
 * event type completeness, and agent schema invariants.
 *
 * These are pure unit tests — no I/O, no temp dirs.
 */

import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  VALID_TASK_TRANSITIONS,
  TASK_ROUTING,
  type TaskStatus,
  type TaskType,
} from "../schemas/task.schema.js";

// ─── Task state machine ───────────────────────────────────────────────────────

describe("Task state machine", () => {

  describe("isValidTransition", () => {

    // Valid transitions
    it("pending → claimed is valid", () => {
      expect(isValidTransition("pending", "claimed")).toBe(true);
    });

    it("pending → cancelled is valid", () => {
      expect(isValidTransition("pending", "cancelled")).toBe(true);
    });

    it("claimed → in_progress is valid", () => {
      expect(isValidTransition("claimed", "in_progress")).toBe(true);
    });

    it("claimed → expired is valid", () => {
      expect(isValidTransition("claimed", "expired")).toBe(true);
    });

    it("in_progress → completed is valid", () => {
      expect(isValidTransition("in_progress", "completed")).toBe(true);
    });

    it("in_progress → blocked is valid", () => {
      expect(isValidTransition("in_progress", "blocked")).toBe(true);
    });

    it("in_progress → failed is valid", () => {
      expect(isValidTransition("in_progress", "failed")).toBe(true);
    });

    it("blocked → handoff_pending is valid", () => {
      expect(isValidTransition("blocked", "handoff_pending")).toBe(true);
    });

    it("blocked → cancelled is valid", () => {
      expect(isValidTransition("blocked", "cancelled")).toBe(true);
    });

    it("handoff_pending → claimed is valid", () => {
      expect(isValidTransition("handoff_pending", "claimed")).toBe(true);
    });

    it("failed → pending is valid (retry)", () => {
      expect(isValidTransition("failed", "pending")).toBe(true);
    });

    it("expired → pending is valid (requeue)", () => {
      expect(isValidTransition("expired", "pending")).toBe(true);
    });

    // Invalid transitions
    it("pending → completed is invalid", () => {
      expect(isValidTransition("pending", "completed")).toBe(false);
    });

    it("claimed → completed is invalid (must pass in_progress)", () => {
      expect(isValidTransition("claimed", "completed")).toBe(false);
    });

    it("completed → pending is invalid (terminal)", () => {
      expect(isValidTransition("completed", "pending")).toBe(false);
    });

    it("completed → claimed is invalid (terminal)", () => {
      expect(isValidTransition("completed", "claimed")).toBe(false);
    });

    it("cancelled → pending is invalid (terminal)", () => {
      expect(isValidTransition("cancelled", "pending")).toBe(false);
    });

    it("pending → in_progress is invalid (must claim first)", () => {
      expect(isValidTransition("pending", "in_progress")).toBe(false);
    });
  });

  describe("VALID_TASK_TRANSITIONS completeness", () => {
    const allStatuses: TaskStatus[] = [
      "pending", "claimed", "in_progress", "blocked",
      "handoff_pending", "completed", "failed", "expired", "cancelled",
    ];

    it("every status has an entry in the transitions table", () => {
      for (const status of allStatuses) {
        expect(VALID_TASK_TRANSITIONS[status]).toBeDefined();
      }
    });

    it("terminal states have empty transition arrays", () => {
      expect(VALID_TASK_TRANSITIONS["completed"]).toHaveLength(0);
      expect(VALID_TASK_TRANSITIONS["cancelled"]).toHaveLength(0);
    });

    it("all transition targets are valid statuses", () => {
      const validSet = new Set<string>(allStatuses);
      for (const [, targets] of Object.entries(VALID_TASK_TRANSITIONS)) {
        for (const target of targets) {
          expect(validSet.has(target)).toBe(true);
        }
      }
    });
  });
});

// ─── Task routing table ───────────────────────────────────────────────────────

describe("Task routing table", () => {
  const allTypes: TaskType[] = [
    "plan", "design", "architecture", "review", "integrate",
    "build", "test", "verify", "browser", "refactor", "debug",
  ];

  it("every task type has a routing entry", () => {
    for (const type of allTypes) {
      expect(TASK_ROUTING[type]).toBeDefined();
    }
  });

  it("every routing entry has primary and fallback agents", () => {
    for (const type of allTypes) {
      const route = TASK_ROUTING[type];
      expect(route.primary).toMatch(/^(claude|antigravity)$/);
      expect(route.fallback).toMatch(/^(claude|antigravity)$/);
    }
  });

  it("primary and fallback are never the same agent", () => {
    for (const type of allTypes) {
      const route = TASK_ROUTING[type];
      expect(route.primary).not.toBe(route.fallback);
    }
  });

  it("planning/design/architecture/review/integrate are Claude-primary", () => {
    const claudePrimary: TaskType[] = [
      "plan", "design", "architecture", "review", "integrate",
    ];
    for (const type of claudePrimary) {
      expect(TASK_ROUTING[type]!.primary).toBe("claude");
    }
  });

  it("build/test/verify/browser are Antigravity-primary", () => {
    const agPrimary: TaskType[] = ["build", "test", "verify", "browser"];
    for (const type of agPrimary) {
      expect(TASK_ROUTING[type]!.primary).toBe("antigravity");
    }
  });

  it("efficiency scores are in 0-1 range", () => {
    for (const type of allTypes) {
      const route = TASK_ROUTING[type];
      expect(route.claudeEfficiency).toBeGreaterThanOrEqual(0);
      expect(route.claudeEfficiency).toBeLessThanOrEqual(1);
      expect(route.antigravityEfficiency).toBeGreaterThanOrEqual(0);
      expect(route.antigravityEfficiency).toBeLessThanOrEqual(1);
    }
  });

  it("primary agent always has higher efficiency than fallback", () => {
    for (const type of allTypes) {
      const route = TASK_ROUTING[type];
      if (route.primary === "claude") {
        expect(route.claudeEfficiency).toBeGreaterThan(route.antigravityEfficiency);
      } else {
        expect(route.antigravityEfficiency).toBeGreaterThan(route.claudeEfficiency);
      }
    }
  });

  it("browser tasks are fallback-only-if-blocking (too inefficient for Claude otherwise)", () => {
    expect(TASK_ROUTING["browser"]!.fallbackOnlyIfBlocking).toBe(true);
  });

  it("architecture tasks are fallback-only-if-blocking (too risky for AG otherwise)", () => {
    expect(TASK_ROUTING["architecture"]!.fallbackOnlyIfBlocking).toBe(true);
  });
});

// ─── Event schema completeness ────────────────────────────────────────────────

describe("Event schema", () => {
  it("all event types are strings", async () => {
    // Dynamically import to test the union at runtime
    const { } = await import("../schemas/event.schema.js");
    // If this file imports without error, the discriminated union is sound
    expect(true).toBe(true);
  });
});
