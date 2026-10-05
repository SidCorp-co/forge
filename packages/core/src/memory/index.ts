export { runConsolidationSweep } from './consolidation.js';
export { runMemoryDecay } from './decay.js';
export { runEmbeddingBackfill } from './embedding-backfill.js';
export { registerMemoryExtraction } from './extraction.js';
export {
  deleteMemory,
  registerMemoryIndexer,
} from './indexer.js';
export { provideMemoryIssueReads } from './ports.js';
export { registerMemoryReconcileTrigger, registerMemoryReconcileWorker } from './reconcile.js';
export { retrievalAnalyticsRetention } from './retention.js';
export { foreignScriptChars } from './script-guard.js';
export type { MemoryHit } from './search.js';
export { runMemorySearch } from './search-service.js';
export { NEAR_DUPLICATE_THRESHOLD } from './thresholds.js';
export { runMemoryWrite } from './write-service.js';
