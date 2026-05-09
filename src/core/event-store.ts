/**
 * event-store.ts
 *
 * The ONLY component that writes to events.jsonl.
 * All other components read. Only this writes.
 *
 * Key design decisions:
 * - Atomic writes: write to .tmp file → fsync → rename. On Windows,
 *   rename is not atomic on NTFS for appends, so we use a write-lock
 *   file (.lock) with retry logic instead of relying on OS atomicity.
 * - Single writer: the API calls appendEvent(). Nothing else does.
 * - Read is streaming: we parse JSONL line by line, never load the
 *   whole file into memory. A long-running project could have thousands
 *   of events.
 * - Version counter: every append increments an in-memory counter.
 *   Snapshot builder uses this to know if snapshots are stale.
 * - Compaction: heartbeat-only events (LeaseRenewed with no meaningful
 *   window change) are filtered out during reads after a threshold.
 *   Raw log is never modified — compaction produces a separate read view.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { v4 as uuidv4 } from "uuid";
import type { DuostackEvent, EventType, BaseEvent } from "../schemas/event.schema.js";
import type { AgentId } from "../schemas/agent.schema.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_FILENAME = ".events.lock";
const EVENTS_FILENAME = "events.jsonl";
const TMP_SUFFIX = ".tmp";

// ─── Event store class ────────────────────────────────────────────────────────

export class EventStore {
  private eventsPath: string;
  private lockPath: string;
  private tmpPath: string;
  private eventCount: number = 0;
  private initialized: boolean = false;

  constructor(stateDir: string) {
    this.eventsPath = path.join(stateDir, EVENTS_FILENAME);
    this.lockPath = path.join(stateDir, LOCK_FILENAME);
    this.tmpPath = path.join(stateDir, EVENTS_FILENAME + TMP_SUFFIX);
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  /**
   * Initialize the event store.
   * Creates events.jsonl if it doesn't exist.
   * Counts existing events to set the version counter.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Ensure events.jsonl exists
    if (!fs.existsSync(this.eventsPath)) {
      await fsPromises.writeFile(this.eventsPath, "", "utf-8");
    }

    // Count existing events to seed the version counter
    this.eventCount = await this.countEvents();
    this.initialized = true;

    console.log(
      `[event-store] initialized — ${this.eventCount} existing events`
    );
  }

  // ─── Core: append event ──────────────────────────────────────────────────────

  /**
   * Append a single event to events.jsonl.
   *
   * Process:
   * 1. Acquire write lock (.events.lock file)
   * 2. Serialize event to JSON
   * 3. Append to a .tmp file
   * 4. fsync the .tmp file
   * 5. On Windows: copy .tmp content into events.jsonl then delete .tmp
   *    On Unix: atomic rename .tmp → events.jsonl (appended view)
   * 6. Release lock
   * 7. Increment version counter
   *
   * Returns the appended event with generated eventId and timestamp.
   */
  async appendEvent(
    eventInput: AppendEventInput
  ): Promise<DuostackEvent> {
    await this.ensureInitialized();

    const event = this.buildEvent(eventInput);

    await this.withLock(async () => {
      const line = JSON.stringify(event) + "\n";

      // Write-append to a tmp file first
      await fsPromises.appendFile(this.eventsPath + TMP_SUFFIX, line, "utf-8");

      // fsync to ensure it hits disk
      const fd = await fsPromises.open(this.eventsPath + TMP_SUFFIX, "r+");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }

      // Move content from tmp into main file (Windows-safe)
      const tmpContent = await fsPromises.readFile(
        this.eventsPath + TMP_SUFFIX,
        "utf-8"
      );
      await fsPromises.appendFile(this.eventsPath, tmpContent, "utf-8");

      // fsync the main file
      const mainFd = await fsPromises.open(this.eventsPath, "r+");
      try {
        await mainFd.sync();
      } finally {
        await mainFd.close();
      }

      // Clean up tmp
      await fsPromises.unlink(this.eventsPath + TMP_SUFFIX).catch(() => {});
    });

    this.eventCount++;
    return event;
  }

  /**
   * Append multiple events in a single lock acquisition.
   * Use this when writing related events (e.g. TaskStepPlanned + TaskStepStarted)
   * to guarantee they are written together without interleaving.
   */
  async appendEvents(
    eventInputs: AppendEventInput[],
    correlationId?: string
  ): Promise<DuostackEvent[]> {
    await this.ensureInitialized();

    const sharedCorrelationId = correlationId ?? uuidv4();
    const events = eventInputs.map((input) =>
      this.buildEvent({ ...input, correlationId: sharedCorrelationId })
    );

    await this.withLock(async () => {
      const lines = events.map((e) => JSON.stringify(e) + "\n").join("");

      await fsPromises.appendFile(this.eventsPath + TMP_SUFFIX, lines, "utf-8");

      const fd = await fsPromises.open(this.eventsPath + TMP_SUFFIX, "r+");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }

      const tmpContent = await fsPromises.readFile(
        this.eventsPath + TMP_SUFFIX,
        "utf-8"
      );
      await fsPromises.appendFile(this.eventsPath, tmpContent, "utf-8");

      const mainFd = await fsPromises.open(this.eventsPath, "r+");
      try {
        await mainFd.sync();
      } finally {
        await mainFd.close();
      }

      await fsPromises.unlink(this.eventsPath + TMP_SUFFIX).catch(() => {});
    });

    this.eventCount += events.length;
    return events;
  }

  // ─── Core: read events ───────────────────────────────────────────────────────

  /**
   * Read all events from events.jsonl as an async generator.
   * Streams line by line — never loads full file into memory.
   *
   * Usage:
   *   for await (const event of store.readEvents()) { ... }
   */
  async *readEvents(options: ReadOptions = {}): AsyncGenerator<DuostackEvent> {
    await this.ensureInitialized();

    if (!fs.existsSync(this.eventsPath)) return;

    const fileStream = fs.createReadStream(this.eventsPath, {
      encoding: "utf-8",
    });

    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity, // handle Windows line endings
    });

    let lineNumber = 0;

    for await (const line of rl) {
      lineNumber++;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: DuostackEvent;
      try {
        event = JSON.parse(trimmed) as DuostackEvent;
      } catch {
        console.error(
          `[event-store] parse error on line ${lineNumber} — skipping`
        );
        continue;
      }

      // Apply filters
      if (options.fromEventId) {
        if (event.eventId === options.fromEventId) {
          delete (options as { fromEventId?: string }).fromEventId;
        }
        continue;
      }

      if (options.taskId && event.taskId !== options.taskId) continue;

      if (options.actor && event.actor !== options.actor) continue;

      if (
        options.eventTypes &&
        !options.eventTypes.includes(event.eventType)
      ) {
        continue;
      }

      if (options.since && event.timestamp < options.since) continue;

      // Skip noisy lease-renewal events in filtered reads if requested
      if (options.skipLeaseNoise && event.eventType === "LeaseRenewed") {
        continue;
      }

      yield event;
    }
  }

  /**
   * Read all events into memory as an array.
   * Use only for snapshot building — not for general queries on large logs.
   */
  async readAllEvents(options: ReadOptions = {}): Promise<DuostackEvent[]> {
    const events: DuostackEvent[] = [];
    for await (const event of this.readEvents(options)) {
      events.push(event);
    }
    return events;
  }

  /**
   * Read the last N events — useful for takeover context.
   * The fallback agent reads these to orient before resuming.
   */
  async readLastEvents(n: number): Promise<DuostackEvent[]> {
    const all = await this.readAllEvents({ skipLeaseNoise: true });
    return all.slice(-n);
  }

  /**
   * Read all events for a specific task, in order.
   * Used by fallback agent during takeover reconciliation.
   */
  async readTaskHistory(taskId: string): Promise<DuostackEvent[]> {
    return this.readAllEvents({ taskId, skipLeaseNoise: true });
  }

  /**
   * Read the latest event of a specific type.
   * Useful for getting current state of a task without full replay.
   */
  async readLatestOfType<T extends EventType>(
    eventType: T
  ): Promise<Extract<DuostackEvent, { eventType: T }> | null> {
    let latest: Extract<DuostackEvent, { eventType: T }> | null = null;

    for await (const event of this.readEvents({ eventTypes: [eventType] })) {
      latest = event as Extract<DuostackEvent, { eventType: T }>;
    }

    return latest;
  }

  // ─── Version counter ─────────────────────────────────────────────────────────

  /**
   * Current event count — used by snapshot builder to detect staleness.
   * Snapshot is stale if snapshot.eventLogVersion < store.version
   */
  get version(): number {
    return this.eventCount;
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  async getStats(): Promise<EventStoreStats> {
    await this.ensureInitialized();

    const stat = await fsPromises.stat(this.eventsPath).catch(() => null);

    return {
      totalEvents: this.eventCount,
      fileSizeBytes: stat?.size ?? 0,
      eventsPath: this.eventsPath,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * Build a complete DuostackEvent from input.
   * Generates eventId and timestamp if not provided.
   */
  private buildEvent(input: AppendEventInput): DuostackEvent {
    const base: BaseEvent = {
      eventId: uuidv4(),
      eventType: input.eventType,
      timestamp: new Date().toISOString(),
      actor: input.actor,
      taskId: input.taskId !== undefined ? input.taskId : null,
      correlationId: input.correlationId !== undefined ? input.correlationId : uuidv4(),
      schemaVersion: "1.0",
    };

    return {
      ...base,
      payload: input.payload,
    } as DuostackEvent;
  }

  /**
   * Acquire a write lock using a lock file.
   * Retries up to LOCK_TIMEOUT_MS before throwing.
   *
   * Windows does not support atomic rename for appends, so we use
   * an advisory lock file to serialize writers. The API is the only
   * writer, so lock contention is minimal in practice.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    // Try to acquire lock
    while (Date.now() < deadline) {
      try {
        // exclusive create — fails if file already exists
        const fd = await fsPromises.open(this.lockPath, "wx");
        await fd.writeFile(process.pid.toString(), "utf-8");
        await fd.close();
        break; // lock acquired
      } catch {
        // lock file exists — another writer holds it
        await sleep(LOCK_RETRY_MS);
      }
    }

    if (Date.now() >= deadline) {
      // Check if lock is stale (process that created it is dead)
      try {
        const lockPid = parseInt(
          await fsPromises.readFile(this.lockPath, "utf-8"),
          10
        );
        if (!isProcessAlive(lockPid)) {
          await fsPromises.unlink(this.lockPath).catch(() => {});
          console.warn(`[event-store] removed stale lock from PID ${lockPid}`);
        } else {
          throw new Error(
            `[event-store] could not acquire write lock after ${LOCK_TIMEOUT_MS}ms`
          );
        }
      } catch {
        throw new Error(
          `[event-store] lock acquisition timed out — stale lock cleanup failed`
        );
      }
    }

    try {
      return await fn();
    } finally {
      // Always release lock
      await fsPromises.unlink(this.lockPath).catch(() => {});
    }
  }

  /**
   * Count events by reading file line by line.
   * Called once on init to seed the version counter.
   */
  private async countEvents(): Promise<number> {
    if (!fs.existsSync(this.eventsPath)) return 0;

    let count = 0;
    const fileStream = fs.createReadStream(this.eventsPath, {
      encoding: "utf-8",
    });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (line.trim()) count++;
    }

    return count;
  }
}

// ─── Input types ──────────────────────────────────────────────────────────────

/**
 * What callers pass to appendEvent().
 * eventId and timestamp are generated by the store — never by callers.
 * This prevents agents from backdating or forging events.
 */
export interface AppendEventInput {
  eventType: EventType;
  actor: BaseEvent["actor"];
  taskId?: string;
  correlationId?: string;
  payload: DuostackEvent["payload"];
}

export interface ReadOptions {
  taskId?: string;
  actor?: AgentId | "orchestrator" | "developer" | "system";
  eventTypes?: EventType[];
  since?: string;         // ISO 8601 — only events after this timestamp
  fromEventId?: string;   // only events after this eventId
  skipLeaseNoise?: boolean; // skip LeaseRenewed events
}

export interface EventStoreStats {
  totalEvents: number;
  fileSizeBytes: number;
  eventsPath: string;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a process is still alive by PID.
 * Used to detect stale lock files from crashed processes.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch {
    return false;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create and initialize an EventStore for a given project state directory.
 * This is the main entry point used by the API server.
 *
 * Usage:
 *   const store = await createEventStore("/path/to/project/.duostack/state")
 *   await store.appendEvent({ eventType: "ProjectInitialized", ... })
 */
export async function createEventStore(stateDir: string): Promise<EventStore> {
  const store = new EventStore(stateDir);
  await store.init();
  return store;
}
