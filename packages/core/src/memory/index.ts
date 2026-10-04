export { registerChunkReindex } from './chunk-reindex.js';
export {
  registerMemoryReconcileTrigger,
  registerMemoryReconcileWorker,
  runConsolidationSweep,
} from './consolidation.js';
export { runMemoryDecay } from './decay.js';
export { runChunkBackfill, runEmbeddingBackfill } from './embedding-backfill.js';
export { registerMemoryExtraction } from './extraction.js';
export { registerMemoryIndexer } from './indexer.js';
export { foreignScriptChars } from './script-guard.js';
export { runMemorySearch } from './search-service.js';
export type { HandoffScope, HandoffStep, StepHandoffPayload } from './step-handoff-schema.js';
export {
  isHandoffStep,
  renderDriveTerminationBlock,
  renderTerminationBlock,
} from './step-handoff-schema.js';
export { NEAR_DUPLICATE_THRESHOLD } from './thresholds.js';
export { runMemoryWrite } from './write-service.js';
