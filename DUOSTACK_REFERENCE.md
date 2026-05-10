# Duostack — Complete Project Reference

> Two-agent orchestration. Claude Desktop plans. Antigravity builds.
> When either goes down, the other picks up exactly where things stopped.

---

## Project stats

| Metric | Value |
|---|---|
| TypeScript source | 13,542 lines |
| Test files | 11 |
| Tests | 194 (all passing) |
| Type errors | 0 |
| MCP tools | 19 |
| API endpoints | 31 |
| CLI commands | 6 |
| Event types | 26 |

---

## Complete directory structure

```
duostack-core/                         ← standalone reusable repo
│
├── README.md                          ← user-facing setup and usage guide
├── CONTRIBUTING.md                    ← architecture guide for contributors
├── LICENSE                            ← MIT
├── .gitignore
├── package.json
├── tsconfig.json
├── vitest.config.ts
│
├── src/
│   │
│   ├── schemas/                       ← types only, no logic, no I/O
│   │   ├── index.ts                   ← barrel export for all schemas
│   │   ├── event.schema.ts            ← 26 event types, discriminated union
│   │   ├── task.schema.ts             ← state machine, routing table, step model
│   │   └── agent.schema.ts            ← observed availability, lease, token health
│   │
│   ├── core/                          ← all business logic
│   │   ├── index.ts                   ← barrel export for all core modules
│   │   ├── event-store.ts             ← ONLY writer to events.jsonl (atomic)
│   │   ├── snapshot-builder.ts        ← replays events → derived snapshots
│   │   ├── handoff-manager.ts         ← lease expiry detection + reconciliation
│   │   ├── task-router.ts             ← role-aware, token-health-aware routing
│   │   ├── orchestrator.ts            ← hybrid poll+watch coordination loop
│   │   ├── config.ts                  ← typed config with deep-merge defaults
│   │   ├── project-init.ts            ← preflight checks + ProjectInitialized event
│   │   ├── stacklit-bridge.ts         ← token-health-aware Stacklit reader
│   │   └── efficiency-tracker.ts      ← waste detection from event log patterns
│   │
│   ├── api/                           ← local HTTP server (only write path)
│   │   ├── server.ts                  ← Express app, mounts all routers
│   │   └── routes/
│   │       ├── events.ts              ← POST /events + read endpoints
│   │       ├── tasks.ts               ← claim, progress, complete, reconcile
│   │       ├── agents.ts              ← status, health, override
│   │       ├── snapshot.ts            ← orientation, scoped reads
│   │       ├── handoff.ts             ← request, status, recover
│   │       ├── stacklit.ts            ← codebase navigation endpoints
│   │       └── dashboard.ts           ← SSE live status dashboard
│   │
│   ├── mcp/
│   │   └── server.ts                  ← 19 MCP tools for Claude Desktop
│   │
│   ├── cli/
│   │   └── index.ts                   ← 6 CLI commands
│   │
│   └── __tests__/
│       ├── schemas.test.ts            ← 31 tests: state machine, routing table
│       ├── event-store.test.ts        ← 22 tests: append, read, filter, lock
│       ├── snapshot-builder.test.ts   ← 13 tests: event replay, derived state
│       ├── task-router.test.ts        ← 15 tests: routing, fallback, token health
│       ├── config.test.ts             ← 15 tests: defaults, merge, load, write
│       ├── stacklit-bridge.test.ts    ← 19 tests: index, derive, query, cache
│       ├── efficiency-tracker.test.ts ← 11 tests: waste detection, reporting
│       ├── project-init.test.ts       ← 16 tests: preflight, init, idempotency
│       ├── integration.test.ts        ← 4 scenarios: normal, death, reset, checkpoint
│       ├── server.test.ts             ← 37 tests: every HTTP endpoint
│       └── handoff-route.test.ts      ← 11 tests: request, status, recover
│
your-project/                          ← project-local state (in your repo)
│
├── stacklit.json                      ← codebase map (Stacklit owns, commit it)
├── DEPENDENCIES.md                    ← Mermaid dependency graph (Stacklit, commit it)
│
└── .duostack/
    ├── duostack.config.json           ← project config (commit it)
    ├── decisions.md                   ← architectural decisions (ALWAYS commit)
    ├── claude-mcp.json                ← merge into claude_desktop_config.json
    │
    ├── state/
    │   ├── events.jsonl               ← append-only source of truth (commit it)
    │   ├── tasks.snapshot.json        ← derived (optional commit)
    │   ├── agents.snapshot.json       ← derived (do not commit)
    │   ├── project.snapshot.json      ← derived (do not commit)
    │   └── efficiency.json            ← waste analysis (do not commit)
    │
    └── antigravity/
        ├── rules.md                   ← AG role, preflight, token health rules
        └── skills/
            ├── orient.md              ← session-start orientation skill
            ├── claim_task.md          ← task claiming skill
            ├── plan_step.md           ← intent-before-action skill
            └── complete_step.md       ← result recording skill
```

---

## What each file does

### Schemas (types only)

| File | What it defines |
|---|---|
| `event.schema.ts` | 26 event types (`TaskCreated`, `AgentUnavailableObserved`, etc), all payloads, `DuostackEvent` discriminated union |
| `task.schema.ts` | `TaskStatus` (9 states), `TaskType` (11 types), `TaskStep`, `HandoffPayload`, `TASK_ROUTING` table, `isValidTransition()` |
| `agent.schema.ts` | `AgentHealth` (6 levels), `AgentSnapshot`, `TaskLease`, `AgentsSnapshot`, `RoutingDecision` |

### Core

| File | Responsibility |
|---|---|
| `event-store.ts` | Atomic append-only writer. Windows-safe file locking. Streaming JSONL reader. Version counter. The only component that writes to `events.jsonl`. |
| `snapshot-builder.ts` | Replays all events in order → derives `tasks.snapshot.json`, `agents.snapshot.json`, `project.snapshot.json`. Atomic snapshot writes (temp→rename). Staleness detection. |
| `handoff-manager.ts` | Detects silent agent death via lease expiry. Triggers handoff events. Builds `ReconciliationInstruction` (last intent + last reality for fallback). Exponential backoff on unavailable agents. |
| `task-router.ts` | Routes tasks to primary/fallback agent based on task type, agent health, token level, dependency satisfaction, and priority. Returns `StacklitReadMode` per assignment. |
| `orchestrator.ts` | Main coordination loop. Hybrid poll (30s) + file-watcher. Manages orchestrator lock. Wires all core components. `initOnly()` for tests. |
| `config.ts` | Loads `duostack.config.json` with deep-merge defaults. Cached after first load. `loadSync()` for CLI. |
| `project-init.ts` | Preflight checks (state dir, git, Stacklit, port, Node version). Writes `ProjectInitialized` event. Extracts goal/stack from `stacklit.json`. Idempotent. |
| `stacklit-bridge.ts` | Three read modes: `full_index` (~4k tokens), `derive_map` (~250 tokens, generated in-process), `mcp_query` (~150 tokens per module). 5-min TTL cache. Fuzzy module matching. |
| `efficiency-tracker.ts` | Analyzes `events.jsonl` for waste patterns: missing step plans, handoff loops, high attempt counts, skipped checkpoints. Writes `efficiency.json`. |

### API routes

| File | Endpoints |
|---|---|
| `events.ts` | `POST /events` (validate + append + rebuild), `GET /events/recent`, `GET /events/task/:id`, `GET /events/stats` |
| `tasks.ts` | `GET /tasks`, `GET /tasks/:id`, `POST /tasks/:id/claim`, `POST /tasks/:id/progress`, `POST /tasks/:id/complete`, `POST /tasks/:id/block`, `POST /tasks/:id/handoff`, `GET /tasks/:id/reconcile` |
| `agents.ts` | `GET /agents`, `GET /agents/:id`, `POST /agents/status`, `POST /agents/override` |
| `snapshot.ts` | `GET /snapshot` (full), `GET /snapshot/tasks`, `GET /snapshot/agents`, `GET /snapshot/project`, `GET /snapshot/stale`, `GET /snapshot/orientation` |
| `handoff.ts` | `POST /handoff/request` (all tasks), `GET /handoff/status`, `POST /handoff/recover` |
| `stacklit.ts` | `GET /stacklit/status`, `GET /stacklit/context`, `GET /stacklit/module/:query`, `GET /stacklit/deps/:module`, `GET /stacklit/full` |
| `dashboard.ts` | `GET /dashboard` (HTML), `GET /dashboard/stream` (SSE, 5s refresh) |

### MCP tools (Claude Desktop)

| Tool | What it calls | When |
|---|---|---|
| `ds_orient` | `GET /snapshot/orientation` | First call every session |
| `ds_agent_status` | `POST /agents/status` | Session start + health changes |
| `ds_codebase` | `GET /stacklit/context` | After orient — repo structure |
| `ds_module` | `GET /stacklit/module/:q` | Before touching a module |
| `ds_deps` | `GET /stacklit/deps/:m` | Before a refactor |
| `ds_read_snapshot` | `GET /snapshot/tasks` | More task detail |
| `ds_create_task` | `POST /events` (TaskCreated) | During planning |
| `ds_claim_task` | `POST /tasks/:id/claim` | Before starting a task |
| `ds_plan_step` | `POST /tasks/:id/progress` | Before every step — mandatory |
| `ds_complete_step` | `POST /tasks/:id/complete` | After every step |
| `ds_block_task` | `POST /tasks/:id/block` | Cannot proceed |
| `ds_request_handoff` | `POST /tasks/:id/handoff` | Hand off one task |
| `ds_handoff_all` | `POST /handoff/request` | Final flush — all tasks |
| `ds_recover` | `POST /handoff/recover` | New session after exhaustion |
| `ds_record_decision` | `POST /events` (DecisionRecorded) + `decisions.md` | Every arch decision |
| `ds_checkpoint` | `POST /events` (ProjectCheckpointWritten) | After decisions/task batches |
| `ds_task_history` | `GET /events/task/:id` | Taking over from Antigravity |
| `ds_reconcile` | `GET /tasks/:id/reconcile` | Before continuing AG's task |
| `ds_efficiency` | `GET /events/stats` | Periodically — waste check |

### CLI commands

| Command | What it does |
|---|---|
| `duostack init --project <path>` | Creates `.duostack/`, writes config, runs preflight, writes `ProjectInitialized` event |
| `duostack serve --project <path>` | Starts orchestrator + API server + optional MCP. Wires Stacklit + Efficiency. |
| `duostack status` | Hits live API, prints agent health + task pipeline counts |
| `duostack handoff --task <id> --to <agent>` | Forces a manual handoff for one task |
| `duostack efficiency --project <path>` | Runs efficiency analysis, prints waste report |
| `duostack dashboard` | Opens live dashboard in default browser |

---

## How to use it

### Step 1 — Install

```bash
git clone https://github.com/yourname/duostack-core
cd duostack-core
npm install
npm run build
npm link          # makes `duostack` available globally
```

### Step 2 — Initialize your project

```bash
cd your-project

# First: set up Stacklit (codebase index)
npx stacklit@0.3.0 init --hook

# Then: set up Duostack
duostack init --project .
```

`init` creates `.duostack/`, runs preflight checks, and writes the first coordination event.

### Step 3 — Configure Claude Desktop

Merge the generated `your-project/.duostack/claude-mcp.json` into your Claude Desktop config:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "stacklit": {
      "command": "stacklit",
      "args": ["serve"]
    },
    "duostack": {
      "command": "node",
      "args": ["/path/to/duostack-core/dist/cli/index.js", "serve",
               "--project", "/path/to/your-project", "--mcp"],
      "env": { "DUOSTACK_PROJECT_PATH": "/path/to/your-project" }
    }
  }
}
```

Restart Claude Desktop. The 19 `ds_*` tools will appear.

### Step 4 — Configure Antigravity

In Antigravity, open workspace settings and paste the contents of:
- `.duostack/antigravity/rules.md` → into workspace rules
- `.duostack/antigravity/skills/*.md` → into `.agent/skills/` in your project

### Step 5 — Start the server

```bash
duostack serve --project /path/to/your-project --mcp
```

Output:
```
Duostack running:
  API:       http://127.0.0.1:3747
  Dashboard: http://127.0.0.1:3747/dashboard
  Stacklit:  ✓ available
  MCP:       running (stdio)
```

### Step 6 — Start every Claude session

```
ds_agent_status(health: "normal", reason: "session start")
ds_orient()
ds_codebase(health: "normal")
```

That's ~500 tokens for full orientation. Then work.

---

## The 3 rules that cannot be broken

**1. Only `EventStore` writes to `events.jsonl`.**
Nothing else. Not routes, not the orchestrator, not tests. The API calls `store.appendEvent()`. If you write directly to the state directory anywhere else, coordination breaks.

**2. Write intent before execution.**
`ds_plan_step` before executing. `POST /tasks/:id/progress` before building. If an agent dies between writing intent and finishing work, the fallback reads the intent and reconciles against the repo. Skip this and the fallback has nothing to work with.

**3. Checkpoint continuously.**
`ds_checkpoint` after every major decision. Context saturation is survivable only if the checkpoint exists. A new Claude session reads the last checkpoint and continues. Without it, the session starts from scratch.

---

## What happens when an agent dies silently

```
Antigravity writes TaskStepPlanned (intent)
Antigravity starts executing
Antigravity dies — no goodbye, no summary
```

The system handles this in three layers:

**Layer 1 — Lease expiry.** Every task has a 20-minute lease. The orchestrator checks every 30 seconds. When the lease expires with no renewal, it emits `TaskLeaseExpired` and `AgentUnavailableObserved`.

**Layer 2 — Reconciliation.** The fallback agent calls `GET /tasks/:id/reconcile`. It gets:
- `lastIntent` — what was planned (from `TaskStepPlanned`)
- `lastReality` — what actually changed (from `ArtifactsObserved` git hash)
- `instructions` — run git diff, run validation, continue or rollback

**Layer 3 — Idempotent steps.** Every step is small enough to re-run safely (`isIdempotent: true`). Even if the fallback re-executes a completed step, it produces the same result.

---

## Token efficiency rules

| Token health | Stacklit read | Task scope | Checkpoint |
|---|---|---|---|
| `normal` | `ds_codebase(normal)` → derive map 250t | All tasks | After each decision |
| `batching` | `ds_codebase(batching)` → derive map 250t | Batch 3-5 tasks | After each batch |
| `triage` | `ds_codebase(triage)` → derive map 250t | Critical path only | After each task |
| `final_flush` | Skip (unless new module) | Stop new work | Write handoffs |
| `exhausted` | Skip | Stop completely | None |

**Final flush sequence:**
```
ds_agent_status(health: "final_flush", reason: "context approaching limit")
ds_handoff_all(reason: "...", contextForFallback: "key context here")
ds_agent_status(health: "exhausted", reason: "session ending")
```

---

## Test breakdown

| File | Tests | What it proves |
|---|---|---|
| `schemas.test.ts` | 31 | Every valid/invalid state transition, routing table completeness, efficiency scores in range, primary always higher efficiency than fallback |
| `event-store.test.ts` | 22 | Atomic append, streaming read, filtering, version counter, re-init from existing log |
| `snapshot-builder.test.ts` | 13 | Full task lifecycle replay, agent health transitions, derived indexes, staleness |
| `task-router.test.ts` | 15 | Primary/fallback routing, token health modes, dependency checking, priority sort |
| `config.test.ts` | 15 | Defaults, deep merge, file load, write, loadSync, malformed JSON |
| `stacklit-bridge.test.ts` | 19 | Full index, derive map, module query, fuzzy match, token health modes, caching |
| `efficiency-tracker.test.ts` | 11 | Missing step plans, handoff loops, high attempt count, checkpoint skipped |
| `project-init.test.ts` | 16 | Preflight checks, event writing, idempotency, Stacklit extraction, snapshot creation |
| `integration.test.ts` | 4 | Normal flow, silent Antigravity death + Claude takeover, weekly reset, checkpoint recovery |
| `server.test.ts` | 37 | Every HTTP endpoint — health, events, tasks, agents, snapshots, reconcile |
| `handoff-route.test.ts` | 11 | Global handoff request, status, recover, reconcile URL format |
| **Total** | **194** | |

---

## Architecture decisions locked in

| Decision | Reason |
|---|---|
| `events.jsonl` append-only, never edited | Replay is deterministic. Any state can be derived. No race conditions. |
| Local API as only write path | Agents can't corrupt state with direct file writes. Schema validation happens once. |
| Snapshots derived, never hand-edited | Consistent with event log at all times. Rebuild from scratch if corrupted. |
| Stacklit read-only from Duostack | Stacklit owns its artifacts. Duostack reads them. No conflict. |
| Observed availability, not token APIs | Neither Claude nor Antigravity exposes reliable token-remaining APIs. Infer from behavior. |
| Step-level checkpoints, not file-level | One event per step. File-level is noise. Step-level is useful for reconciliation. |
| Task-level lease heartbeats | Distinguishes "one task stalled" from "whole agent gone". |
| Intent written before execution | Fallback agents can recover even from mid-step death. |
| Idempotent steps | Safe to re-run. Takeover never causes double-writes. |
| TypeScript strict + exactOptionalPropertyTypes | Prevents `undefined` leaking into optional fields. Catches real coordination bugs at compile time. |

---

## Running it

```bash
# Development
npm run test:watch      # run tests on change
npm run typecheck       # type-check without building
npm run build           # compile to dist/

# Using it
duostack init --project /path/to/project
duostack serve --project /path/to/project --mcp
duostack status
duostack dashboard
duostack efficiency --project /path/to/project
duostack handoff --task task_001 --to claude --reason "..."
```
