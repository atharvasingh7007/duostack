# Skill: claim_task

Claim a task from the pending queue and start a lease.

## When to use

After orientation, when you have identified a task to work on.

## Prerequisites

- All tasks in `dependsOn` must be `completed`
- Your health must be `normal`, `batching`, or `triage` (not `final_flush` or `exhausted`)
- The task must be `pending` or `handoff_pending`

## Steps

**1. Check the task**
```
GET http://127.0.0.1:3747/tasks/:taskId
```
Confirm status is `pending` or `handoff_pending` and you are the `primaryAgent` or `fallbackAgent`.

**2. Claim it**
```
POST http://127.0.0.1:3747/tasks/:taskId/claim
{ "agent": "antigravity" }
```

Response includes `leaseExpiresAt` — you have 20 minutes before the orchestrator considers your lease expired.

**3. If taking over a handoff**
```
GET http://127.0.0.1:3747/tasks/:taskId/reconcile
```
Always reconcile before continuing a task that was previously worked on. Run git diff and validation.

**4. Read the module you're working in**
```
GET http://127.0.0.1:3747/stacklit/module/:moduleName
```
Do this before writing any code. Understand exports, dependencies, and what depends on it.

**5. Then use plan_step skill before any execution**

## Note on leases

The orchestrator renews your lease automatically while you're active. If you stop responding for 20 minutes, the lease expires and the task is reassigned. Write step progress events regularly — this signals liveness.
