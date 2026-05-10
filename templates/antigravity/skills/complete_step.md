# Skill: complete_step

Record step result after execution and validation.

## When to use

After every step completes — whether it passed or failed.
Always record the outcome. Claude and the orchestrator need to know exactly what happened.

## Steps

**1. Get the git hash**
```bash
git rev-parse HEAD
```
This is your `gitDiffHash`. The fallback agent uses it to verify exactly what files changed.

**2. Run your validation commands**

Run the commands you listed in `plan_step.validation`.
Note whether they passed and capture any relevant output.

**3. Record the result**
```
POST http://127.0.0.1:3747/tasks/:taskId/complete
{
  "agent": "antigravity",
  "stepId": "step_001",
  "actualFilesChanged": ["src/auth/middleware.ts", "src/auth/types.ts"],
  "gitDiffHash": "abc123def456",
  "validationPassed": true,
  "notes": "Used express-jwt v9. Had to add custom error handler for expired tokens — see src/auth/middleware.ts line 34.",
  "taskComplete": false
}
```

Set `taskComplete: true` only when:
- All steps are completed
- All acceptance criteria in the task are satisfied
- All validation passes

**4. If validation failed**

Still record the result with `validationPassed: false`:
```
POST http://127.0.0.1:3747/tasks/:taskId/complete
{
  "agent": "antigravity",
  "stepId": "step_001",
  "actualFilesChanged": ["src/auth/middleware.ts"],
  "gitDiffHash": "abc123def456",
  "validationPassed": false,
  "notes": "Tests failing — express-jwt v9 changed the error format. Switching to v8."
}
```

Then follow the `nextActionIfFailure` path from your step plan.

## What goes in `notes`

Notes are read by Claude during review and by agents during takeover. Include:
- Library versions used and why
- Surprising behaviour encountered
- Design choices made during execution
- Anything the next step needs to know
- File locations of key implementation details

Notes are NOT a log dump. Keep them to 2-3 sentences of genuinely useful context.

## What `taskComplete: true` does

When you set `taskComplete: true`, the API atomically appends:
1. `TaskStepCompleted` + `ArtifactsObserved` for the step
2. `TaskCompleted` for the whole task

The task moves to `completed` status and Claude is notified for review.
