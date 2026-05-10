# Contributing to Duostack

## Architecture overview

Duostack is organized into five layers. Understanding the dependency direction between them is critical before making changes.

```
schemas → core → api → mcp/cli
                ↓
              tests (reach into all layers)
```

**Schemas** define types only — no logic, no I/O. Everything else imports from here.

**Core** contains all business logic. Each file has one job:
- `event-store.ts` — the only writer to `events.jsonl`
- `snapshot-builder.ts` — replays events into derived state
- `handoff-manager.ts` — detects agent death, orchestrates recovery
- `task-router.ts` — decides which agent handles which task
- `orchestrator.ts` — ties everything together, runs the main loop
- `config.ts` — typed config with sensible defaults
- `project-init.ts` — initialization and preflight checks
- `stacklit-bridge.ts` — reads Stacklit index, token-health-aware
- `efficiency-tracker.ts` — analyzes event log for waste patterns

**API** is the HTTP surface. Routes are thin — they validate input, call core methods, return JSON. No business logic lives in routes.

**MCP** wraps the API for Claude Desktop. Tools are semantic wrappers — `ds_plan_step` not `ds_append_event`.

**CLI** is the user-facing entry point. Commands call core/api directly or hit the running API server.

---

## The one rule that cannot be broken

**Only `event-store.ts` writes to `events.jsonl`.**

Nothing else. Not routes, not the orchestrator, not tests. The API calls `store.appendEvent()`. The orchestrator calls `store.appendEvent()`. Nothing bypasses the store.

If you find yourself writing to the state directory from anywhere other than `EventStore`, stop.

---

## Adding a new event type

1. Add the type to `EventType` union in `event.schema.ts`
2. Add the payload interface in `event.schema.ts`
3. Add to the `DuostackEvent` discriminated union
4. Add a handler in `snapshot-builder.ts` `applyEvent()` switch statement
5. Add to `VALID_EVENT_TYPES` in `api/routes/events.ts`
6. Write a test in `__tests__/snapshot-builder.test.ts` covering the new transition

---

## Adding a new MCP tool

1. Add the tool definition to the `TOOLS` array in `mcp/server.ts`
2. Add the case to `handleTool()` switch in `mcp/server.ts`
3. All tool logic should call the API — never call core directly from MCP
4. Update the MCP tools table in `README.md`

---

## Adding a new API route

1. Create or modify a file in `src/api/routes/`
2. Mount it in `src/api/server.ts`
3. Routes must only: validate input → call core/store → return JSON
4. All state mutations must go through `store.appendEvent()` then `snapshots.rebuildAll()`
5. Write server integration tests in `__tests__/server.test.ts`

---

## Testing philosophy

Tests use real temp directories — no mocked file I/O. This catches Windows path issues, atomic write behavior, and file locking edge cases that in-memory mocks would hide.

The server test uses `orchestrator.initOnly()` to boot the Express server without the poll loop, file watcher, or process lock. This keeps tests fast and isolated.

When adding tests:
- Unit tests go in the corresponding `__tests__/*.test.ts` file
- If you're testing a new interaction between multiple core components, add a scenario to `integration.test.ts`
- If you're testing a new API endpoint, add it to `server.test.ts`

---

## Development workflow

```bash
# Install dependencies
npm install

# Run tests in watch mode while developing
npm run test:watch

# Typecheck (faster than full build)
npm run typecheck

# Build for distribution
npm run build

# Test against a real project
duostack init --project /path/to/test-project
duostack serve --project /path/to/test-project
```

---

## Commit checklist

Before submitting a PR:

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm test` passes (all 194+ tests)
- [ ] New behavior has tests
- [ ] No direct file writes outside `EventStore`
- [ ] No `require()` — this is a pure ESM codebase
- [ ] `README.md` updated if you changed the public API, added CLI commands, or added MCP tools
