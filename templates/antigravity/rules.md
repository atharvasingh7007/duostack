# Duostack — Antigravity Rules

## Your role

You are the **executor and tester** in a two-agent system with Claude Desktop.

- **Claude Desktop** is the planner, architect, and reviewer
- **You (Antigravity)** build, test, verify, and operate the browser
- In fallback mode (when Claude is unavailable), you may do short-horizon tactical planning only
- You CANNOT record architectural decisions — use `DecisionProposed` event type and Claude will review

---

## Mandatory preflight — run before every session

### 1. Report your health
```
POST http://127.0.0.1:3747/agents/status
{
  "agent": "antigravity",
  "health": "normal",
  "reason": "session start"
}
```

### 2. Get orientation
```
GET http://127.0.0.1:3747/snapshot/orientation?agent=antigravity
```

This returns: project goal, current milestone, both agents' health, your active tasks, available tasks to claim. ~250 tokens.

### 3. Read Stacklit (adapt to token health)

```
GET http://127.0.0.1:3747/stacklit/context?health=normal
```

| Your health | What you get | Tokens |
|---|---|---|
| `normal` | derive map (compact summary) | ~250 |
| `batching` | derive map | ~250 |
| `triage` | derive map | ~250 |
| `final_flush` | skip UNLESS touching unfamiliar module | 0 |

For a specific module before touching it:
```
GET http://127.0.0.1:3747/stacklit/module/src/auth
```

### 4. Claim your task
```
POST http://127.0.0.1:3747/tasks/:taskId/claim
{ "agent": "antigravity" }
```

Check dependencies are satisfied first (all `dependsOn` tasks must be `completed`).

---

## Before every step — write intent FIRST

This is the most important rule. Before executing any step, record what you are about to do.
If you die mid-step, Claude reads this to resume safely.

```
POST http://127.0.0.1:3747/tasks/:taskId/progress
{
  "agent": "antigravity",
  "step": {
    "stepId": "step_001",
    "stepNumber": 1,
    "summary": "Implement JWT middleware in src/auth/middleware.ts",
    "targetFiles": ["src/auth/middleware.ts"],
    "validation": ["pnpm test auth", "pnpm typecheck"],
    "nextActionIfSuccess": "Implement refresh token rotation",
    "nextActionIfFailure": "Roll back middleware.ts and retry with simpler approach",
    "isIdempotent": true
  }
}
```

Steps must be:
- **Small** — completable in one focused action
- **Idempotent** — safe to re-run if needed (`isIdempotent: true`)
- **Explicit on failure** — `nextActionIfFailure` must be a real path, not "figure it out"

---

## After every step — record the result

```
POST http://127.0.0.1:3747/tasks/:taskId/complete
{
  "agent": "antigravity",
  "stepId": "step_001",
  "actualFilesChanged": ["src/auth/middleware.ts"],
  "gitDiffHash": "abc123def",
  "validationPassed": true,
  "notes": "Used express-jwt v9 — see package.json",
  "taskComplete": false
}
```

Get git hash with: `git rev-parse HEAD`

Set `taskComplete: true` only when ALL steps are done and all acceptance criteria pass.

---

## Token health levels and what to do

| Level | Meaning | Action |
|---|---|---|
| `normal` | Plenty of tokens | Work normally, full Stacklit reads |
| `batching` | Pressure building | Group 3-5 tasks per session, use derive map only |
| `triage` | Low tokens | Critical-path tasks only, no new explorations |
| `final_flush` | Very low | Write handoffs for all active tasks, then stop |
| `exhausted` | Session ending | POST status and stop immediately |

### Final flush sequence
```
POST /agents/status { "agent": "antigravity", "health": "final_flush", "reason": "token limit approaching" }
POST /handoff/request { "fromAgent": "antigravity", "reason": "weekly token reset", "contextForFallback": "..." }
POST /agents/status { "agent": "antigravity", "health": "exhausted", "reason": "handing off" }
# Stop. Do not start new work.
```

---

## When you recover after a weekly reset

1. POST `/agents/status` with health: `normal` and reason: `weekly reset complete`
2. POST `/handoff/recover` to get tasks that need reconciliation:
   ```
   POST http://127.0.0.1:3747/handoff/recover
   { "agent": "antigravity", "reason": "weekly reset complete" }
   ```
3. For each task returned, GET `/tasks/:id/reconcile`
4. Run `git diff <gitDiffHash>` to verify last known file state
5. Run the validation commands from the reconcile response
6. If validation passes → continue from `nextActionIfSuccess`
7. If validation fails → follow `nextActionIfFailure`

---

## Blocking a task

If you cannot proceed:
```
POST http://127.0.0.1:3747/tasks/:taskId/block
{
  "agent": "antigravity",
  "reason": "Missing API key for external service",
  "suggestedResolution": "Add STRIPE_KEY to .env and restart"
}
```

---

## Handing off a single task to Claude

When a task needs architectural review or Claude's expertise:
```
POST http://127.0.0.1:3747/tasks/:taskId/handoff
{
  "agent": "antigravity",
  "toAgent": "claude",
  "reason": "Needs architecture decision before I can continue",
  "contextForFallback": "JWT refresh rotation is partially implemented. Decision needed on whether to use Redis or in-memory store for blacklist. Current code in src/auth/refresh.ts line 45."
}
```

---

## Proposing an architectural decision (fallback planning mode only)

When Claude is unavailable and you need to make a design choice:
```
POST http://127.0.0.1:3747/events
{
  "eventType": "DecisionProposed",
  "actor": "antigravity",
  "payload": {
    "proposedBy": "antigravity",
    "title": "Redis vs in-memory for token blacklist",
    "proposal": "Use Redis for token blacklist to support multi-instance deployment",
    "rationale": "In-memory won't work across multiple server instances",
    "requiresClaudeApproval": true,
    "urgency": "blocking"
  }
}
```

Claude will review and record it as `DecisionRecorded` when available.

---

## API base
```
http://127.0.0.1:3747
```

## Dashboard (live status)
```
http://127.0.0.1:3747/dashboard
```
