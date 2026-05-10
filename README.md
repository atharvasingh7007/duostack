# Duostack

**Two-agent orchestration for serious projects.**

Claude Desktop handles planning, architecture, and review.
Antigravity handles building, testing, and execution.
When either goes down — context cliff, weekly reset, any reason — the other picks up exactly where things stopped.

---

## What it solves

| Problem | Without Duostack | With Duostack |
|---|---|---|
| Claude context fills up | Restart, re-explain everything | New session reads checkpoint, continues instantly |
| Antigravity weekly reset | Wait a week, lose momentum | Claude executes in fallback, Antigravity resumes on recovery |
| Agent dies mid-task | Work is lost or duplicated | Lease expiry detected, git diff + validation reconciles state |
| Two agents step on each other | No coordination, conflicts | Lease-based ownership, one owner per task at all times |
| Decisions lost between sessions | Re-derive architecture from scratch | `decisions.md` persists all architectural choices |

---

## Prerequisites

- Node.js 20+
- Windows, macOS, or Linux
- Claude Desktop installed
- Google Antigravity installed
- Git (for diff-based reconciliation)

---

## Installation

```bash
npm install -g duostack-core
```

Or clone and build:

```bash
git clone https://github.com/yourname/duostack-core
cd duostack-core
npm install
npm run build
npm link
```

---

## Setup (one time per project)

### 1. Initialize Stacklit

Duostack uses Stacklit as its codebase navigation layer. Initialize it first:

```bash
cd your-project
npx stacklit@0.3.0 init --hook
```

This creates `stacklit.json` (codebase index) and installs a git hook to keep it fresh.

### 2. Initialize Duostack

```bash
duostack init --project C:\path\to\your-project
```

This creates:

```
your-project/
└── .duostack/
    ├── duostack.config.json     ← project config
    ├── decisions.md             ← architectural decisions (commit this)
    ├── claude-mcp.json          ← merge into claude_desktop_config.json
    ├── state/
    │   └── events.jsonl         ← source of truth (commit this)
    └── antigravity/
        ├── rules.md             ← Antigravity's operating rules
        └── skills/
            ├── orient.md
            ├── claim_task.md
            ├── plan_step.md
            └── complete_step.md
```

### 3. Configure Claude Desktop

Open `your-project/.duostack/claude-mcp.json` and merge the `mcpServers` block into your Claude Desktop config:

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
      "args": ["path/to/duostack-core/dist/cli/index.js", "serve", "--project", "C:\\path\\to\\your-project", "--mcp"],
      "env": {
        "DUOSTACK_PROJECT_PATH": "C:\\path\\to\\your-project"
      }
    }
  }
}
```

Restart Claude Desktop. You should see Duostack tools appear.

### 4. Configure Antigravity

Copy `.duostack/antigravity/rules.md` content into Antigravity's workspace rules, and copy the skills files to `.agent/skills/` in your project.

---

## Daily workflow

### Starting a session (Claude)

Every Claude session starts with this exact sequence:

```
1. ds_agent_status(health: "normal", reason: "session start")
2. ds_orient()
3. ds_codebase(health: "normal")
```

`ds_orient` gives you project state in ~250 tokens. `ds_codebase` gives you repo structure in ~250 tokens. Together that's your complete orientation in ~500 tokens — then you work.

**If recovering after a previous session was exhausted:**
```
1. ds_agent_status(health: "normal", reason: "recovering after context reset")
2. ds_recover(reason: "new session")   ← returns tasks to reconcile
3. For each task returned: ds_reconcile(taskId)
4. ds_orient()
```

### Planning (Claude)

```
ds_create_task(
  taskId: "task_001",
  title: "Implement auth module",
  type: "build",                    ← routes to Antigravity
  priority: "high",
  acceptanceCriteria: ["JWT works", "Tests pass"]
)

ds_record_decision(
  decisionId: "D-2026-04-12-001",
  title: "JWT strategy",
  decision: "Use 15min expiry with refresh rotation",
  rationale: "Balances security and UX",
  constraints: ["All tokens must be invalidatable"],
  status: "FINAL"
)

ds_checkpoint(
  summary: "Auth module planned, decision recorded",
  milestone: "Auth design complete"
)
```

**Call `ds_checkpoint` after every major decision.** This makes Claude context saturation survivable.

### Executing (Antigravity)

Antigravity runs `orient` skill, claims a task, then before every step:

```
POST /tasks/task_001/progress
{
  "agent": "antigravity",
  "step": {
    "stepId": "step_001",
    "summary": "Implement JWT middleware",
    "targetFiles": ["src/auth/middleware.ts"],
    "validation": ["pnpm test auth"],
    "nextActionIfSuccess": "Implement refresh rotation",
    "nextActionIfFailure": "Roll back and retry simpler approach",
    "isIdempotent": true
  }
}
```

After step completes:

```
POST /tasks/task_001/complete
{
  "agent": "antigravity",
  "stepId": "step_001",
  "actualFilesChanged": ["src/auth/middleware.ts"],
  "gitDiffHash": "abc123",
  "validationPassed": true
}
```

---

## Token health protocol

Both agents should report their health as it changes:

| Level | When | Stacklit read | Action |
|---|---|---|---|
| `normal` | Session start, plenty of tokens | `ds_codebase(normal)` → derive map | Work normally |
| `batching` | Token pressure building | `ds_codebase(batching)` → derive map | Group 3-5 tasks per call |
| `triage` | Low tokens | `ds_codebase(triage)` → derive map | Critical-path tasks only |
| `final_flush` | Very low tokens | Skip Stacklit | Call `ds_handoff_all`, then stop |
| `exhausted` | Session ending | Skip | Post status, stop all work |

**The final_flush sequence (Claude):**
```
ds_agent_status(health: "final_flush", reason: "context approaching limit")
ds_handoff_all(reason: "context limit", contextForFallback: "key context here")
ds_agent_status(health: "exhausted", reason: "handing off")
# Stop. Do not start new tasks.
```

**Antigravity final_flush (via skills/rules):**
```
POST /agents/status { health: "final_flush" }
POST /handoff/request { fromAgent: "antigravity", reason: "token limit" }
POST /agents/status { health: "exhausted" }
```

---

## Handoff protocol

### Automatic (lease expiry)

When an agent goes silent, the orchestrator detects lease expiry and automatically triggers handoff. The fallback agent calls `GET /tasks/:id/reconcile` to get takeover instructions.

### Agent-initiated: single task

```
ds_request_handoff(
  taskId: "task_001",
  toAgent: "antigravity",
  reason: "better suited for browser testing",
  contextForFallback: "Using ioredis, schema in src/db/schema.ts line 42"
)
```

### Agent-initiated: all tasks (final_flush)

```
ds_handoff_all(
  reason: "context limit approaching",
  contextForFallback: "Architecture decisions in decisions.md. JWT with 15min expiry."
)
```

Via API (Antigravity):
```bash
POST /handoff/request
{ "fromAgent": "antigravity", "reason": "weekly token reset" }
```

### Manual (developer override)

```bash
duostack handoff --task task_001 --to claude --reason "Antigravity weekly reset"
```

### Recovery after downtime

When Antigravity returns after a weekly reset:

```bash
# Via API (Antigravity skill):
POST /handoff/recover
{ "agent": "antigravity", "reason": "weekly reset complete" }
# Returns: list of tasks to reconcile

GET /tasks/:id/reconcile   # for each returned task
```

Via Claude MCP:
```
ds_recover(reason: "new session after context reset")
# Returns: tasks to reconcile + reconcile URLs
```

---

## Recovery protocol

### When Antigravity returns after weekly reset

1. Post recovery status via Antigravity rules/skill
2. Get orientation: `GET /snapshot/orientation?agent=antigravity`
3. For any `handoff_pending` tasks: `GET /tasks/:id/reconcile`
4. Run `git diff <gitDiffHash>` to verify last known state
5. Run validation commands
6. Continue from `nextActionIfSuccess` or `nextActionIfFailure`

### When a new Claude session starts

1. `ds_agent_status(health: "normal", reason: "new session")`
2. `ds_orient()` — reads checkpoint + snapshot, full context in ~250 tokens
3. `ds_read_snapshot()` if more detail needed
4. Continue planning or review from where things were

---

## CLI reference

```bash
# Initialize a project
duostack init --project <path>

# Start Duostack (orchestrator + API + optionally MCP)
duostack serve --project <path> [--port 3747] [--mcp]

# Check current state
duostack status [--project <path>]

# Force a handoff
duostack handoff --task <taskId> --to <claude|antigravity> [--reason "..."]
```

---

## API reference

All agents talk to `http://127.0.0.1:3747`.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server health + event log version |
| POST | `/events` | Append an event (primary write path) |
| GET | `/events/recent` | Last N events (skips lease noise) |
| GET | `/events/task/:id` | Full task history (for reconciliation) |
| GET | `/events/stats` | Event log size and staleness |
| GET | `/tasks` | List tasks (filterable by status/agent/priority) |
| GET | `/tasks/:id` | Single task with full step history |
| POST | `/tasks/:id/claim` | Claim a task and start a lease |
| POST | `/tasks/:id/progress` | Write step intent + start (atomic pair) |
| POST | `/tasks/:id/complete` | Record step result + optional task completion |
| POST | `/tasks/:id/block` | Mark task blocked |
| POST | `/tasks/:id/handoff` | Request handoff for a single task |
| GET | `/tasks/:id/reconcile` | Get takeover instructions (intent + reality) |
| GET | `/agents` | Both agents' current health |
| GET | `/agents/:id` | Single agent snapshot |
| POST | `/agents/status` | Agent self-reports health |
| POST | `/agents/override` | Developer force-sets agent status |
| POST | `/handoff/request` | Agent hands off ALL its active tasks |
| GET | `/handoff/status` | Current handoff state across all tasks |
| POST | `/handoff/recover` | Agent signals recovery, gets tasks to reconcile |
| GET | `/snapshot/orientation` | Minimal session-start context (<2k tokens) |
| GET | `/snapshot/tasks` | Tasks snapshot (scope/agent/limit filters) |
| GET | `/snapshot/agents` | Agents snapshot |
| GET | `/snapshot/project` | Project snapshot |
| GET | `/snapshot/stale` | Check if snapshots need rebuild |
| GET | `/stacklit/context` | Token-health-aware codebase context |
| GET | `/stacklit/module/:query` | Single module lookup (fuzzy match) |
| GET | `/stacklit/deps/:module` | Dependency graph for a module |
| GET | `/stacklit/full` | Full stacklit.json index |
| GET | `/stacklit/status` | Stacklit availability and stats |
| GET | `/dashboard` | Live status dashboard (SSE auto-refresh) |

---

## MCP tools (Claude Desktop)

| Tool | When to call |
|---|---|
| `ds_orient` | First call every session |
| `ds_agent_status` | Right after orient — report health: normal |
| `ds_codebase` | After orient — get codebase context (token-health-aware) |
| `ds_module` | Before modifying a module — understand exports and deps |
| `ds_deps` | Before a refactor — understand blast radius |
| `ds_read_snapshot` | When you need more task detail than orient gives |
| `ds_create_task` | During planning |
| `ds_claim_task` | Before starting work on a task |
| `ds_plan_step` | Before every step — mandatory |
| `ds_complete_step` | After every step |
| `ds_block_task` | When you cannot proceed |
| `ds_request_handoff` | Hand off a single task to Antigravity |
| `ds_handoff_all` | Hand off ALL active tasks (use in final_flush mode) |
| `ds_recover` | Start of a new session after a previous one was exhausted |
| `ds_record_decision` | After every significant architectural choice |
| `ds_checkpoint` | After every major decision or task batch |
| `ds_task_history` | When taking over a task from Antigravity |
| `ds_reconcile` | Before continuing a task Antigravity was working on |
| `ds_efficiency` | Periodically — check waste patterns and get recommendations |

---

## State files

All state lives in `.duostack/state/`. Commit everything except lock files.

| File | What it is | Commit? |
|---|---|---|
| `events.jsonl` | Append-only event log — source of truth | Yes |
| `tasks.snapshot.json` | Derived task state | Optional |
| `agents.snapshot.json` | Derived agent health | No |
| `project.snapshot.json` | Derived project state | No |
| `.orchestrator.lock` | Process lock | No (gitignored) |
| `.events.lock` | Write lock | No (gitignored) |

The `decisions.md` file is at `.duostack/decisions.md` — always commit it.

---

## Architecture

```
duostack-core/          ← standalone repo, reusable
├── core/
│   ├── event-store.ts        atomic append-only writer
│   ├── snapshot-builder.ts   derives state from event replay
│   ├── handoff-manager.ts    lease expiry detection + reconciliation
│   ├── task-router.ts        role-aware, token-health-aware routing
│   ├── orchestrator.ts       hybrid poll+watch coordination loop
│   ├── config.ts             typed config with deep-merge defaults
│   ├── project-init.ts       preflight checks + initialization
│   ├── stacklit-bridge.ts    token-health-aware Stacklit reader
│   ├── efficiency-tracker.ts waste detection from event log
│   └── index.ts              barrel export
├── api/
│   ├── server.ts             Express app, mounts all routers
│   └── routes/
│       ├── events.ts         POST /events (only write path)
│       ├── tasks.ts          claim, progress, complete, reconcile
│       ├── agents.ts         status, health, override
│       ├── snapshot.ts       orientation, scoped reads
│       ├── handoff.ts        request, status, recover
│       ├── stacklit.ts       codebase navigation
│       └── dashboard.ts      SSE live status dashboard
├── mcp/
│   └── server.ts             19 tools for Claude Desktop
├── cli/
│   └── index.ts              init, serve, status, handoff, efficiency, dashboard
└── schemas/
    ├── event.schema.ts       26 event types, discriminated union
    ├── task.schema.ts        state machine, routing table, step model
    └── agent.schema.ts       observed availability, lease, token health

your-project/           ← project-local state
├── stacklit.json             codebase map (Stacklit owns this)
└── .duostack/
    ├── duostack.config.json  project config
    ├── decisions.md          strategic memory (commit this)
    ├── state/
    │   ├── events.jsonl      source of truth (commit this)
    │   ├── tasks.snapshot.json
    │   ├── agents.snapshot.json
    │   └── project.snapshot.json
    └── antigravity/
        ├── rules.md          AG role and operating rules
        └── skills/           claim_task, plan_step, complete_step, orient
```

---

## Running tests

```bash
npm test              # run all tests
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```

194 tests across 11 files covering: event store, snapshot builder, task router, task schema state machine, integration scenarios (normal flow, silent death, weekly reset, checkpoint recovery), full API server endpoints, handoff routes, config loading, Stacklit bridge, efficiency tracker, and project initialization.

---

## License

MIT
