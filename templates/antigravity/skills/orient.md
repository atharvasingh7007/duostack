# Skill: orient

Get session-start orientation from Duostack. Run this at the start of every session before claiming any task.

## Steps

**1. Report health**
```
POST http://127.0.0.1:3747/agents/status
{ "agent": "antigravity", "health": "normal", "reason": "session start" }
```

**2. Get orientation**
```
GET http://127.0.0.1:3747/snapshot/orientation?agent=antigravity
```

Read the response:
- `goal` — what the project is building
- `currentMilestone` — where we are right now
- `agentHealth` — both agents' status and health level
- `myActiveTasks` — tasks already assigned to you (resume these first)
- `availableTasks` — tasks you can claim next

**3. Read Stacklit based on your token health**
```
GET http://127.0.0.1:3747/stacklit/context?health=normal
```

Use `health=batching` if you're under token pressure. This returns a ~250-token derive map regardless.

**4. If you have active tasks from a previous session**

For each task in `myActiveTasks` where status is `handoff_pending` or `in_progress`:
```
GET http://127.0.0.1:3747/tasks/:taskId/reconcile
```
Run git diff and validation before continuing.

## What orientation costs

~500 tokens total:
- 250 tokens for orientation snapshot
- 250 tokens for Stacklit derive map

Then you know exactly what to do. Don't skip this.
