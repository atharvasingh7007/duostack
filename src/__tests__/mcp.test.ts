/**
 * __tests__/mcp.test.ts
 *
 * Tests for the MCP server and tool handlers.
 * Verifies that all 19 MCP tools map correctly to the local API
 * and respect agent personas and environmental overrides.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fsPromises from "node:fs/promises";
import {
  TOOLS,
  getApiBase,
  getAgentId,
  handleTool,
  apiCall,
} from "../mcp/server.js";

let tmpDir: string;

describe("MCP Server", () => {
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "duostack-mcp-test-"));
    await fsPromises.mkdir(path.join(tmpDir, ".duostack"), { recursive: true });
  });

  afterAll(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("Configuration & Personas", () => {
    it("exports 19 tools", () => {
      expect(TOOLS.length).toBe(19);
      const names = TOOLS.map((t) => t.name);
      expect(names).toContain("ds_orient");
      expect(names).toContain("ds_read_snapshot");
      expect(names).toContain("ds_create_task");
      expect(names).toContain("ds_claim_task");
      expect(names).toContain("ds_plan_step");
      expect(names).toContain("ds_complete_step");
      expect(names).toContain("ds_block_task");
      expect(names).toContain("ds_request_handoff");
      expect(names).toContain("ds_record_decision");
      expect(names).toContain("ds_checkpoint");
      expect(names).toContain("ds_agent_status");
      expect(names).toContain("ds_task_history");
      expect(names).toContain("ds_reconcile");
      expect(names).toContain("ds_codebase");
      expect(names).toContain("ds_module");
      expect(names).toContain("ds_deps");
      expect(names).toContain("ds_efficiency");
      expect(names).toContain("ds_handoff_all");
      expect(names).toContain("ds_recover");
    });

    it("resolves default API base", () => {
      delete process.env["DUOSTACK_PORT"];
      delete process.env["PORT"];
      delete process.env["DUOSTACK_HOST"];
      delete process.env["HOST"];
      expect(getApiBase()).toBe("http://127.0.0.1:3747");
    });

    it("respects custom host and port env vars", () => {
      process.env["DUOSTACK_HOST"] = "0.0.0.0";
      process.env["DUOSTACK_PORT"] = "8080";
      expect(getApiBase()).toBe("http://0.0.0.0:8080");
    });

    it("resolves default agent id as claude", () => {
      delete process.env["DUOSTACK_AGENT_ID"];
      expect(getAgentId()).toBe("claude");
    });

    it("respects DUOSTACK_AGENT_ID env var", () => {
      process.env["DUOSTACK_AGENT_ID"] = "antigravity";
      expect(getAgentId()).toBe("antigravity");
    });

    it("allows direct agent override", () => {
      expect(getAgentId("antigravity")).toBe("antigravity");
    });
  });

  describe("apiCall helper", () => {
    it("makes successful GET request", async () => {
      const mockData = { ok: true, version: 1 };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockData,
      } as unknown as Response);

      const result = await apiCall("GET", "/health");
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:3747/health",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("throws on non-ok API response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "Not found" }),
      } as unknown as Response);

      await expect(apiCall("GET", "/not-real")).rejects.toThrow("API error 404");
    });
  });

  describe("handleTool execution", () => {
    beforeEach(() => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        const u = String(url);
        if (u.includes("/snapshot/orientation")) {
          return { ok: true, json: async () => ({ goal: "Test goal", agentHealth: {} }) } as Response;
        }
        if (u.includes("/snapshot/tasks")) {
          return { ok: true, json: async () => ({ tasks: [], total: 0 }) } as Response;
        }
        if (u.includes("/events/task/")) {
          return { ok: true, json: async () => ({ taskId: "t1", events: [] }) } as Response;
        }
        if (u.includes("/tasks/t1/reconcile")) {
          return { ok: true, json: async () => ({ taskId: "t1", instructions: [] }) } as Response;
        }
        if (u.includes("/stacklit/context")) {
          return { ok: true, json: async () => ({ mode: "full", data: {} }) } as Response;
        }
        if (u.includes("/stacklit/module/")) {
          return { ok: true, json: async () => ({ found: true, path: "src/auth" }) } as Response;
        }
        if (u.includes("/stacklit/deps/")) {
          return { ok: true, json: async () => ({ module: "auth", graph: {} }) } as Response;
        }
        if (u.includes("/events/stats")) {
          return { ok: true, json: async () => ({ totalEvents: 42 }) } as Response;
        }
        // Default POST success
        return { ok: true, json: async () => ({ success: true, body: opts?.body }) } as Response;
      });
    });

    it("executes ds_orient", async () => {
      const res = await handleTool("ds_orient", {});
      const parsed = JSON.parse(res);
      expect(parsed.goal).toBe("Test goal");
    });

    it("executes ds_read_snapshot", async () => {
      const res = await handleTool("ds_read_snapshot", { scope: "active", limit: 10 });
      const parsed = JSON.parse(res);
      expect(parsed.tasks).toEqual([]);
    });

    it("executes ds_create_task", async () => {
      const res = await handleTool("ds_create_task", {
        taskId: "task_001",
        title: "Test Task",
        description: "Test description",
        type: "build",
        priority: "high",
        acceptanceCriteria: ["Tests pass"],
      });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_claim_task", async () => {
      const res = await handleTool("ds_claim_task", { taskId: "task_001" });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_plan_step", async () => {
      const res = await handleTool("ds_plan_step", {
        taskId: "task_001",
        stepId: "step_001",
        stepNumber: 1,
        summary: "Do work",
        targetFiles: ["src/index.ts"],
        validation: ["npm test"],
        nextActionIfSuccess: "next",
        nextActionIfFailure: "retry",
        isIdempotent: true,
      });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_complete_step", async () => {
      const res = await handleTool("ds_complete_step", {
        taskId: "task_001",
        stepId: "step_001",
        actualFilesChanged: ["src/index.ts"],
        validationPassed: true,
      });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_block_task", async () => {
      const res = await handleTool("ds_block_task", {
        taskId: "task_001",
        reason: "Blocked on external API",
      });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_request_handoff", async () => {
      const res = await handleTool("ds_request_handoff", {
        taskId: "task_001",
        reason: "Token exhausted",
        contextForFallback: "Continue step 2",
      });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_record_decision", async () => {
      const res = await handleTool("ds_record_decision", {
        decisionId: "dec_001",
        title: "Use Vitest",
        decision: "Adopt Vitest as test runner",
        rationale: "Fast and native ESM support",
        constraints: ["Node 20+"],
        status: "FINAL",
      });
      const parsed = JSON.parse(res);
      expect(parsed.recorded).toBe(true);
      expect(parsed.decisionId).toBe("dec_001");
    });

    it("executes ds_checkpoint", async () => {
      const res = await handleTool("ds_checkpoint", {
        summary: "Sprint 1 finished",
        milestone: "v0.1",
      });
      const parsed = JSON.parse(res);
      expect(parsed.checkpointed).toBe(true);
      expect(parsed.milestone).toBe("v0.1");
    });

    it("executes ds_agent_status", async () => {
      const res = await handleTool("ds_agent_status", {
        health: "normal",
        reason: "starting up",
      });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_task_history", async () => {
      const res = await handleTool("ds_task_history", { taskId: "t1" });
      const parsed = JSON.parse(res);
      expect(parsed.taskId).toBe("t1");
    });

    it("executes ds_reconcile", async () => {
      const res = await handleTool("ds_reconcile", { taskId: "t1" });
      const parsed = JSON.parse(res);
      expect(parsed.taskId).toBe("t1");
    });

    it("executes ds_codebase", async () => {
      const res = await handleTool("ds_codebase", { health: "normal" });
      const parsed = JSON.parse(res);
      expect(parsed.mode).toBe("full");
    });

    it("executes ds_module", async () => {
      const res = await handleTool("ds_module", { query: "auth" });
      const parsed = JSON.parse(res);
      expect(parsed.found).toBe(true);
    });

    it("executes ds_deps", async () => {
      const res = await handleTool("ds_deps", { module: "auth", depth: 2 });
      const parsed = JSON.parse(res);
      expect(parsed.module).toBe("auth");
    });

    it("executes ds_efficiency", async () => {
      const res = await handleTool("ds_efficiency", {});
      const parsed = JSON.parse(res);
      expect(parsed.eventStats.totalEvents).toBe(42);
    });

    it("executes ds_handoff_all", async () => {
      const res = await handleTool("ds_handoff_all", { reason: "session end" });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_recover", async () => {
      const res = await handleTool("ds_recover", { reason: "reset received" });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_record_decision with project path set", async () => {
      process.env["DUOSTACK_PROJECT_PATH"] = tmpDir;
      const res = await handleTool("ds_record_decision", {
        decisionId: "dec_002",
        title: "Test decision",
        decision: "decision text",
        rationale: "rationale text",
        constraints: ["c1"],
        status: "DRAFT",
      });
      const parsed = JSON.parse(res);
      expect(parsed.recorded).toBe(true);
      expect(parsed.writtenToDecisionsMd).toBe(true);
    });

    it("executes ds_codebase with module query param", async () => {
      const res = await handleTool("ds_codebase", { health: "normal", module: "auth" });
      const parsed = JSON.parse(res);
      expect(parsed.mode).toBe("full");
    });

    it("executes ds_request_handoff with explicit toAgent and agent", async () => {
      const res = await handleTool("ds_request_handoff", {
        taskId: "task_001",
        agent: "antigravity",
        toAgent: "claude",
        reason: "Test handoff",
        contextForFallback: "Context",
        doNotTouch: ["src/config.ts"],
      });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("executes ds_complete_step with taskComplete true and notes", async () => {
      const res = await handleTool("ds_complete_step", {
        taskId: "task_001",
        stepId: "step_001",
        actualFilesChanged: ["src/index.ts"],
        validationPassed: true,
        taskComplete: true,
        notes: "Step complete note",
        gitDiffHash: "abc1234",
      });
      const parsed = JSON.parse(res);
      expect(parsed.success).toBe(true);
    });

    it("throws on unknown tool", async () => {
      await expect(handleTool("ds_nonexistent", {})).rejects.toThrow("Unknown tool: ds_nonexistent");
    });
  });
});
