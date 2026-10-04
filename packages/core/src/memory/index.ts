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
export type { MemoryHit } from './search.js';
export { runMemorySearch } from './search-service.js';
