/**
 * core/index.ts
 *
 * Single import point for all core Duostack modules.
 * Consumers can do:
 *   import { createEventStore, createOrchestrator, loadConfig } from "../core/index.js"
 * instead of importing from individual files.
 */

export { createEventStore, EventStore } from "./event-store.js";
export type { AppendEventInput, ReadOptions, EventStoreStats } from "./event-store.js";

export { createSnapshotBuilder, SnapshotBuilder } from "./snapshot-builder.js";
export type { ProjectSnapshot } from "./snapshot-builder.js";

export { createHandoffManager, HandoffManager } from "./handoff-manager.js";
export type {
  HandoffDecision,
  HandoffReason,
  ReconciliationInstruction,
  AgentFailureRecord,
} from "./handoff-manager.js";

export { createTaskRouter, TaskRouter } from "./task-router.js";
export type { RoutingResult, RoutingReason, StacklitReadMode, BatchGroup } from "./task-router.js";

export { createOrchestrator, Orchestrator } from "./orchestrator.js";
export type { OrchestratorConfig } from "./orchestrator.js";

export {
  createConfigLoader,
  loadConfig,
  defaultConfig,
  ConfigLoader,
} from "./config.js";
export type { DuostackConfig, AgentConfig } from "./config.js";

export {
  createProjectInitializer,
  printPreflight,
  ProjectInitializer,
} from "./project-init.js";
export type {
  InitResult,
  PreflightResult,
  PreflightCheck,
} from "./project-init.js";

export { createStacklitBridge, StacklitBridge } from "./stacklit-bridge.js";
export type {
  StacklitIndex,
  StacklitModule,
  DeriveMap,
  ModuleQueryResult,
} from "./stacklit-bridge.js";

export { createEfficiencyTracker, EfficiencyTracker } from "./efficiency-tracker.js";
export type {
  EfficiencyReport,
  AgentEfficiency,
  TaskTypeEfficiency,
  WasteEvent,
  WasteType,
} from "./efficiency-tracker.js";
