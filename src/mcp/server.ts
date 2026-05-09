/**
 * mcp/server.ts
 *
 * The MCP server that Claude Desktop connects to.
 * Exposes Duostack operations as native MCP tools.
 *
 * Key design decisions:
 * - MCP tools are thin wrappers over the local API.
 *   All validation and state mutation happens in the API.
 *   The MCP server just translates MCP tool calls → HTTP requests.
 * - Tools are named with a "ds_" prefix to avoid collision with
 *   other MCP servers Claude might have connected (e.g. Stacklit).
 * - Every tool response includes eventLogVersion so Claude can
 *   detect if its cached context is stale without an extra call.
 * - Token-efficient responses: tools return only what Claude needs,
 *   not full snapshot dumps. ds_orient is the session-start tool.
 * - Claude never calls ds_append_event directly for high-level actions.
 *   It uses semantic tools (ds_plan_step, ds_complete_step) that
 *   compose the right events correctly every time.
 *
 * Tools exposed:
 *   ds_orient          → session start orientation
 *   ds_read_snapshot   → scoped snapshot read
 *   ds_create_task     → create a new task with acceptance criteria
 *   ds_claim_task      → claim a task (start working on it)
 *   ds_plan_step       → write step intent before executing
 *   ds_complete_step   → record step result after executing
 *   ds_block_task      → mark task as blocked
 *   ds_request_handoff → hand off to Antigravity
 *   ds_record_decision → record an architectural decision to decisions.md
 *   ds_checkpoint      → write a project checkpoint
 *   ds_agent_status    → update Claude's own health status
 *   ds_task_history    → full event history for a task (takeover reconcile)
 *   ds_reconcile       → get reconciliation instruction for a task
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PORT } from "../api/server.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const API_BASE = `http://127.0.0.1:${DEFAULT_PORT}`;
const AGENT_ID = "claude";

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "ds_orient",
    description:
      "Session start orientation. Call this FIRST at the start of every session. " +
      "Returns project goal, current milestone, both agents' health, your active tasks, " +
      "and available tasks to claim. Costs ~250 tokens. " +
      "After calling this, call ds_codebase(health:'normal') for codebase orientation.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ds_read_snapshot",
    description:
      "Read current project state. Use after ds_orient when you need more detail. " +
      "Scope to minimize tokens: 'active' returns only non-completed tasks. " +
      "Filter by agent to see only tasks relevant to you.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["active", "all"],
          description: "active = non-completed tasks only (recommended). all = everything.",
        },
        limit: {
          type: "number",
          description: "Max tasks to return. Default 20, max 100.",
        },
      },
      required: [],
    },
  },
  {
    name: "ds_create_task",
    description:
      "Create a new task with acceptance criteria. " +
      "Claude creates tasks during planning. " +
      "Be specific about type — it determines which agent builds it.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Unique task ID, e.g. 'task_001'. Use sequential IDs.",
        },
        title: { type: "string", description: "Short descriptive title." },
        description: { type: "string", description: "Full task description." },
        type: {
          type: "string",
          enum: ["plan", "design", "architecture", "review", "integrate",
                 "build", "test", "verify", "browser", "refactor", "debug"],
          description:
            "Task type determines routing. build/test/verify/browser → Antigravity. " +
            "plan/design/architecture/review/integrate → Claude.",
        },
        priority: {
          type: "string",
          enum: ["critical", "high", "normal", "low"],
        },
        acceptanceCriteria: {
          type: "array",
          items: { type: "string" },
          description: "List of specific, verifiable criteria for task completion.",
        },
        dependsOn: {
          type: "array",
          items: { type: "string" },
          description: "Task IDs that must complete before this one starts.",
        },
      },
      required: ["taskId", "title", "description", "type", "priority", "acceptanceCriteria"],
    },
  },
  {
    name: "ds_claim_task",
    description:
      "Claim a task to start working on it. Creates a 20-minute lease. " +
      "Call this before doing any work on a task. " +
      "Only claim tasks appropriate for Claude (plan/design/architecture/review/integrate). " +
      "In fallback mode you may claim build/test tasks if Antigravity is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "ID of the task to claim." },
      },
      required: ["taskId"],
    },
  },
  {
    name: "ds_plan_step",
    description:
      "Write step intent BEFORE executing it. " +
      "This is the most important tool — call it before every step. " +
      "If this session ends unexpectedly, the other agent uses this to resume. " +
      "Steps must be small and idempotent (safe to re-run).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        stepId: {
          type: "string",
          description: "Unique step ID within the task, e.g. 'step_001'.",
        },
        stepNumber: { type: "number", description: "1-indexed step number." },
        summary: {
          type: "string",
          description: "Plain English: what this step does. Be specific enough for another agent to resume.",
        },
        targetFiles: {
          type: "array",
          items: { type: "string" },
          description: "Files this step will create or modify.",
        },
        validation: {
          type: "array",
          items: { type: "string" },
          description: "Commands to verify this step succeeded, e.g. ['pnpm test auth', 'pnpm typecheck'].",
        },
        nextActionIfSuccess: {
          type: "string",
          description: "What to do next if this step passes validation.",
        },
        nextActionIfFailure: {
          type: "string",
          description: "What to do if validation fails. Be explicit — don't leave this to inference.",
        },
        isIdempotent: {
          type: "boolean",
          description: "Can this step be safely re-run without side effects?",
        },
      },
      required: [
        "taskId", "stepId", "stepNumber", "summary",
        "targetFiles", "validation",
        "nextActionIfSuccess", "nextActionIfFailure", "isIdempotent",
      ],
    },
  },
  {
    name: "ds_complete_step",
    description:
      "Record step completion after validation passes. " +
      "Call this immediately after a step succeeds. " +
      "Provide the actual files changed and git diff hash for reconciliation.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        stepId: { type: "string" },
        actualFilesChanged: {
          type: "array",
          items: { type: "string" },
          description: "Files actually created or modified (may differ from plan).",
        },
        gitDiffHash: {
          type: "string",
          description: "Git commit hash or diff hash. Used by fallback agent for reconciliation.",
        },
        validationPassed: { type: "boolean" },
        notes: {
          type: "string",
          description: "Optional: anything the next agent should know about this step.",
        },
        taskComplete: {
          type: "boolean",
          description: "Set true if this was the final step and the whole task is done.",
        },
      },
      required: ["taskId", "stepId", "actualFilesChanged", "validationPassed"],
    },
  },
  {
    name: "ds_block_task",
    description:
      "Mark a task as blocked. Use when you cannot proceed and need input or resolution. " +
      "Always include a suggested resolution so the other agent or developer knows what's needed.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: { type: "string", description: "Why the task is blocked." },
        suggestedResolution: {
          type: "string",
          description: "What needs to happen to unblock it.",
        },
      },
      required: ["taskId", "reason"],
    },
  },
  {
    name: "ds_request_handoff",
    description:
      "Hand off a task to Antigravity. " +
      "Call this when entering final_flush mode or when Antigravity is better suited. " +
      "Include contextForFallback — the most important field. " +
      "Antigravity reads this to understand your implementation choices.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: { type: "string", description: "Why you're handing off." },
        contextForFallback: {
          type: "string",
          description:
            "Critical context Antigravity needs: libraries used, key decisions, " +
            "file locations, gotchas. Be specific — this replaces a conversation.",
        },
        doNotTouch: {
          type: "array",
          items: { type: "string" },
          description: "Files or modules Antigravity should not modify.",
        },
      },
      required: ["taskId", "reason", "contextForFallback"],
    },
  },
  {
    name: "ds_record_decision",
    description:
      "Record an architectural decision to decisions.md. " +
      "Call this after every significant design choice. " +
      "This is Claude's primary responsibility — decisions must be recorded " +
      "before context fills up or they are lost forever. " +
      "Mark status FINAL when the decision should not be re-evaluated.",
    inputSchema: {
      type: "object",
      properties: {
        decisionId: {
          type: "string",
          description: "Unique ID, format: D-YYYY-MM-DD-NNN, e.g. D-2026-04-12-001.",
        },
        title: { type: "string", description: "Short decision title." },
        decision: {
          type: "string",
          description: "What was decided. One paragraph max.",
        },
        rationale: {
          type: "string",
          description: "Why this decision was made. One paragraph max.",
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "What this decision locks in — what cannot change without revisiting this.",
        },
        status: {
          type: "string",
          enum: ["FINAL", "PROVISIONAL"],
          description: "FINAL = do not re-evaluate. PROVISIONAL = may change.",
        },
      },
      required: ["decisionId", "title", "decision", "rationale", "constraints", "status"],
    },
  },
  {
    name: "ds_checkpoint",
    description:
      "Write a project checkpoint. " +
      "Call this after every major decision, batch of tasks created, or review pass. " +
      "This makes your context saturation survivable — a new Claude session " +
      "reads the checkpoint and continues without loss. " +
      "When in doubt, checkpoint. It costs almost nothing.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What was accomplished since the last checkpoint.",
        },
        milestone: {
          type: "string",
          description: "Current milestone name, e.g. 'Auth module design complete'.",
        },
      },
      required: ["summary", "milestone"],
    },
  },
  {
    name: "ds_agent_status",
    description:
      "Report your health status to the system. " +
      "Call this at session start (normal) and when you notice token pressure. " +
      "Levels: normal → batching (group tasks) → triage (critical only) → " +
      "final_flush (write handoffs, then stop) → exhausted (session ending).",
    inputSchema: {
      type: "object",
      properties: {
        health: {
          type: "string",
          enum: ["normal", "batching", "triage", "final_flush", "exhausted"],
          description: "Your current token health level.",
        },
        reason: {
          type: "string",
          description: "Why you're reporting this status.",
        },
      },
      required: ["health", "reason"],
    },
  },
  {
    name: "ds_task_history",
    description:
      "Get full event history for a task. " +
      "Use this when taking over a task from Antigravity — " +
      "read the history to understand exactly what was done and where things stopped.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "ds_reconcile",
    description:
      "Get reconciliation instructions for a task you are taking over. " +
      "Call this BEFORE continuing any task that was previously worked on by Antigravity. " +
      "Returns: last intent (what was planned), last reality (what actually changed), " +
      "and step-by-step instructions for safe takeover.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "ds_codebase",
    description:
      "Get codebase context from Stacklit. Token-health-aware — pass your current health " +
      "to get the right amount of context automatically. " +
      "normal → derive map (~250 tokens). " +
      "Optionally query a specific module for surgical lookup (~150 tokens). " +
      "Call this early in session after ds_orient when you need to understand the codebase.",
    inputSchema: {
      type: "object",
      properties: {
        health: {
          type: "string",
          enum: ["normal", "batching", "triage", "final_flush", "exhausted"],
          description: "Your current token health level.",
        },
        module: {
          type: "string",
          description:
            "Optional: specific module to look up (e.g. 'src/auth', 'auth'). " +
            "If omitted returns derive map.",
        },
      },
      required: ["health"],
    },
  },
  {
    name: "ds_module",
    description:
      "Look up a specific module in the codebase index. " +
      "Use this before modifying a module — understand its exports, dependencies, " +
      "and what depends on it. Costs ~150 tokens. " +
      "Supports fuzzy matching: 'auth' finds 'src/auth'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Module path or keyword, e.g. 'src/auth' or 'auth'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ds_deps",
    description:
      "Get the dependency graph for a module. " +
      "Use before planning a refactor — understand the blast radius. " +
      "Shows which modules depend on the target and what it depends on.",
    inputSchema: {
      type: "object",
      properties: {
        module: {
          type: "string",
          description: "Module path, e.g. 'src/auth'.",
        },
        depth: {
          type: "number",
          description: "How many levels deep to traverse. Default 2, max 4.",
        },
      },
      required: ["module"],
    },
  },
  {
    name: "ds_efficiency",
    description:
      "Get efficiency report — token waste patterns, handoff analysis, recommendations. " +
      "Call this periodically to check system health and catch coordination problems early. " +
      "Returns waste events, per-agent stats, and actionable recommendations.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ds_handoff_all",
    description:
      "Hand off ALL your active tasks to Antigravity at once. " +
      "Call this when entering final_flush mode — transfers every task you hold. " +
      "After calling this, call ds_agent_status(health:'exhausted') and stop working.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you are handing off all tasks.",
        },
        contextForFallback: {
          type: "string",
          description: "Global context Antigravity needs across all tasks.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "ds_recover",
    description:
      "Signal that you have recovered and are ready to resume work. " +
      "Call this at the start of a new session after a previous session was exhausted. " +
      "Returns a list of tasks that need reconciliation before you can continue.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you are recovering, e.g. 'new session after context reset'.",
        },
      },
      required: ["reason"],
    },
  },
] as const;

// ─── API call helper ──────────────────────────────────────────────────────────

async function apiCall(
  method: "GET" | "POST",
  endpoint: string,
  body?: unknown
): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `API error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {

  switch (name) {

    // ── ds_orient ────────────────────────────────────────────────────────────

    case "ds_orient": {
      const data = await apiCall("GET", `/snapshot/orientation?agent=${AGENT_ID}`);
      return JSON.stringify(data, null, 2);
    }

    // ── ds_read_snapshot ─────────────────────────────────────────────────────

    case "ds_read_snapshot": {
      const scope = args["scope"] ?? "active";
      const limit = args["limit"] ?? 20;
      const data = await apiCall(
        "GET",
        `/snapshot/tasks?scope=${scope}&agent=${AGENT_ID}&limit=${limit}`
      );
      return JSON.stringify(data, null, 2);
    }

    // ── ds_create_task ───────────────────────────────────────────────────────

    case "ds_create_task": {
      const data = await apiCall("POST", "/events", {
        eventType: "TaskCreated",
        actor: AGENT_ID,
        taskId: args["taskId"],
        payload: {
          taskId: args["taskId"],
          title: args["title"],
          description: args["description"],
          type: args["type"],
          priority: args["priority"],
          primaryAgent: getPrimaryAgent(args["type"] as string),
          fallbackAgent: getFallbackAgent(args["type"] as string),
          dependsOn: args["dependsOn"] ?? [],
          acceptanceCriteria: args["acceptanceCriteria"],
        },
      });
      return JSON.stringify(data, null, 2);
    }

    // ── ds_claim_task ────────────────────────────────────────────────────────

    case "ds_claim_task": {
      const data = await apiCall(
        "POST",
        `/tasks/${args["taskId"]}/claim`,
        { agent: AGENT_ID }
      );
      return JSON.stringify(data, null, 2);
    }

    // ── ds_plan_step ─────────────────────────────────────────────────────────

    case "ds_plan_step": {
      const data = await apiCall(
        "POST",
        `/tasks/${args["taskId"]}/progress`,
        {
          agent: AGENT_ID,
          step: {
            stepId: args["stepId"],
            stepNumber: args["stepNumber"],
            summary: args["summary"],
            targetFiles: args["targetFiles"],
            validation: args["validation"],
            nextActionIfSuccess: args["nextActionIfSuccess"],
            nextActionIfFailure: args["nextActionIfFailure"],
            isIdempotent: args["isIdempotent"],
          },
        }
      );
      return JSON.stringify(data, null, 2);
    }

    // ── ds_complete_step ─────────────────────────────────────────────────────

    case "ds_complete_step": {
      const data = await apiCall(
        "POST",
        `/tasks/${args["taskId"]}/complete`,
        {
          agent: AGENT_ID,
          stepId: args["stepId"],
          actualFilesChanged: args["actualFilesChanged"],
          gitDiffHash: args["gitDiffHash"] ?? null,
          validationPassed: args["validationPassed"],
          notes: args["notes"] ?? null,
          taskComplete: args["taskComplete"] ?? false,
        }
      );
      return JSON.stringify(data, null, 2);
    }

    // ── ds_block_task ────────────────────────────────────────────────────────

    case "ds_block_task": {
      const data = await apiCall(
        "POST",
        `/tasks/${args["taskId"]}/block`,
        {
          agent: AGENT_ID,
          reason: args["reason"],
          suggestedResolution: args["suggestedResolution"] ?? null,
        }
      );
      return JSON.stringify(data, null, 2);
    }

    // ── ds_request_handoff ───────────────────────────────────────────────────

    case "ds_request_handoff": {
      const data = await apiCall(
        "POST",
        `/tasks/${args["taskId"]}/handoff`,
        {
          agent: AGENT_ID,
          toAgent: "antigravity",
          reason: args["reason"],
          contextForFallback: args["contextForFallback"],
          doNotTouch: args["doNotTouch"] ?? [],
        }
      );
      return JSON.stringify(data, null, 2);
    }

    // ── ds_record_decision ───────────────────────────────────────────────────

    case "ds_record_decision": {
      // Write to events.jsonl
      const eventData = await apiCall("POST", "/events", {
        eventType: "DecisionRecorded",
        actor: AGENT_ID,
        payload: {
          decisionId: args["decisionId"],
          title: args["title"],
          decision: args["decision"],
          rationale: args["rationale"],
          constraints: args["constraints"],
          status: args["status"],
          doNotReEvaluate: args["status"] === "FINAL",
        },
      });

      // Also append to decisions.md for human readability
      const configPath = process.env["DUOSTACK_PROJECT_PATH"];
      if (configPath) {
        const decisionsPath = path.join(configPath, ".duostack", "decisions.md");
        const entry = formatDecisionEntry(args);
        await appendToDecisions(decisionsPath, entry);
      }

      return JSON.stringify({
        recorded: true,
        decisionId: args["decisionId"],
        writtenToDecisionsMd: !!process.env["DUOSTACK_PROJECT_PATH"],
        event: eventData,
      }, null, 2);
    }

    // ── ds_checkpoint ────────────────────────────────────────────────────────

    case "ds_checkpoint": {
      await orchestratorCheckpoint(
        args["summary"] as string,
        args["milestone"] as string
      );
      return JSON.stringify({
        checkpointed: true,
        milestone: args["milestone"],
        summary: args["summary"],
        timestamp: new Date().toISOString(),
      }, null, 2);
    }

    // ── ds_agent_status ──────────────────────────────────────────────────────

    case "ds_agent_status": {
      const data = await apiCall("POST", "/agents/status", {
        agent: AGENT_ID,
        health: args["health"],
        reason: args["reason"],
      });
      return JSON.stringify(data, null, 2);
    }

    // ── ds_task_history ──────────────────────────────────────────────────────

    case "ds_task_history": {
      const data = await apiCall("GET", `/events/task/${args["taskId"]}`);
      return JSON.stringify(data, null, 2);
    }

    // ── ds_reconcile ─────────────────────────────────────────────────────────

    case "ds_reconcile": {
      const data = await apiCall("GET", `/tasks/${args["taskId"]}/reconcile`);
      return JSON.stringify(data, null, 2);
    }

    // ── ds_codebase ──────────────────────────────────────────────────────────

    case "ds_codebase": {
      const health = args["health"] as string;
      const module = args["module"] as string | undefined;
      const params = new URLSearchParams({ health });
      if (module) params.set("module", module);
      const data = await apiCall("GET", `/stacklit/context?${params}`);
      return JSON.stringify(data, null, 2);
    }

    // ── ds_module ────────────────────────────────────────────────────────────

    case "ds_module": {
      try {
        const data = await apiCall(
          "GET",
          `/stacklit/module/${encodeURIComponent(args["query"] as string)}`
        );
        return JSON.stringify(data, null, 2);
      } catch {
        return JSON.stringify({
          found: false,
          query: args["query"],
          message: "Stacklit not available or module not found. Run: npx stacklit@0.3.0 init --hook",
        }, null, 2);
      }
    }

    // ── ds_deps ──────────────────────────────────────────────────────────────

    case "ds_deps": {
      const depth = args["depth"] ?? 2;
      const data = await apiCall(
        "GET",
        `/stacklit/deps/${encodeURIComponent(args["module"] as string)}?depth=${depth}`
      );
      return JSON.stringify(data, null, 2);
    }

    // ── ds_efficiency ────────────────────────────────────────────────────────

    case "ds_efficiency": {
      // Efficiency report is served from the events endpoint
      const stats = await apiCall("GET", "/events/stats");
      return JSON.stringify({
        message: "Run duostack efficiency --project <path> for full report",
        eventStats: stats,
      }, null, 2);
    }

    // ── ds_handoff_all ───────────────────────────────────────────────────────

    case "ds_handoff_all": {
      const data = await apiCall("POST", "/handoff/request", {
        fromAgent: AGENT_ID,
        reason: args["reason"],
        contextForFallback: args["contextForFallback"] ?? "",
      });
      return JSON.stringify(data, null, 2);
    }

    // ── ds_recover ───────────────────────────────────────────────────────────

    case "ds_recover": {
      const data = await apiCall("POST", "/handoff/recover", {
        agent: AGENT_ID,
        reason: args["reason"],
      });
      return JSON.stringify(data, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPrimaryAgent(taskType: string): string {
  const agMap: Record<string, string> = {
    plan: "claude", design: "claude", architecture: "claude",
    review: "claude", integrate: "claude",
    build: "antigravity", test: "antigravity",
    verify: "antigravity", browser: "antigravity",
    refactor: "antigravity", debug: "claude",
  };
  return agMap[taskType] ?? "claude";
}

function getFallbackAgent(taskType: string): string {
  const primary = getPrimaryAgent(taskType);
  return primary === "claude" ? "antigravity" : "claude";
}

function formatDecisionEntry(args: Record<string, unknown>): string {
  const date = new Date().toISOString().split("T")[0];
  return `
## ${args["decisionId"]} — ${args["title"]}
**Date:** ${date}
**Status:** ${args["status"]}

**Decision:** ${args["decision"]}

**Rationale:** ${args["rationale"]}

**Constraints:**
${(args["constraints"] as string[]).map((c) => `- ${c}`).join("\n")}

---
`;
}

async function appendToDecisions(
  decisionsPath: string,
  entry: string
): Promise<void> {
  try {
    if (!fs.existsSync(decisionsPath)) {
      await fsPromises.writeFile(
        decisionsPath,
        "# Duostack — Architectural Decisions\n\n",
        "utf-8"
      );
    }
    await fsPromises.appendFile(decisionsPath, entry, "utf-8");
  } catch {
    console.error("[mcp] failed to write to decisions.md");
  }
}

async function orchestratorCheckpoint(
  summary: string,
  milestone: string
): Promise<void> {
  await apiCall("POST", "/events", {
    eventType: "ProjectCheckpointWritten",
    actor: AGENT_ID,
    payload: {
      triggeredBy: "scheduled",
      currentMilestone: milestone,
      openTaskCount: 0, // orchestrator will reconcile on next rebuild
      completedTaskCount: 0,
      activeAgent: AGENT_ID,
      summary,
    },
  });
}

// ─── MCP server bootstrap ─────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "duostack",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleTool(name, (args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Connect via stdio (Claude Desktop requirement)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[mcp] Duostack MCP server running — connected to Claude Desktop");
}
