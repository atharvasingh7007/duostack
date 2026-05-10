# Skill: plan_step

Write step intent BEFORE executing. This is the most important skill.

If your session ends unexpectedly, Claude reads this event to understand exactly what you were doing and resume safely.

## The rule

**Always call this BEFORE executing a step. No exceptions.**

Write intent → execute → record result (complete_step skill).
If you die between write and execute — Claude reconciles from intent.
If you die between execute and record — git diff + validation catches it.

## Steps

**1. Decompose the current task into the smallest safe step**

A good step:
- Touches 1-3 files maximum
- Has a clear, testable outcome
- Is idempotent (safe to re-run if needed)
- Takes less than 10 minutes to execute

**2. Write the step plan**
```
POST http://127.0.0.1:3747/tasks/:taskId/progress
{
  "agent": "antigravity",
  "step": {
    "stepId": "step_001",
    "stepNumber": 1,
    "summary": "Implement JWT middleware — verify token, extract userId, attach to req",
    "targetFiles": ["src/auth/middleware.ts"],
    "validation": ["pnpm test auth", "pnpm typecheck"],
    "nextActionIfSuccess": "Implement refresh token endpoint in src/auth/refresh.ts",
    "nextActionIfFailure": "Roll back src/auth/middleware.ts to last committed state and retry with simpler approach — check express-jwt docs",
    "isIdempotent": true
  }
}
```

**3. Execute the step**

Now you can write code, run terminal commands, test in browser.

**4. Immediately use complete_step skill**

Don't do multiple steps without recording each one.

## Good vs bad summaries

❌ Bad: "Work on auth"
✅ Good: "Add JWT validation middleware to src/auth/middleware.ts — verify Bearer token, extract userId from payload, attach to req.user"

❌ Bad nextActionIfFailure: "Try again"
✅ Good nextActionIfFailure: "Roll back middleware.ts — the issue is likely express-jwt version mismatch — try pinning to v8.4.1 in package.json"

## Step numbering

Use sequential step numbers within a task: step_001, step_002, step_003.
Each task has its own sequence starting at 1.
