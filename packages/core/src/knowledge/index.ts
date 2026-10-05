export { runKnowledgeEmbeddingBackfill } from './embedding-backfill.js';
export {
  deleteFeedbackEmbedding,
  EMBEDDING_PROVIDER_NOT_CONFIGURED,
  type ItemEmbeddingStatus,
  itemEmbeddingOf,
  nearestItems,
  unembeddedCounts,
  writeItemEmbedding,
} from './item-embeddings.js';
export { provideKnowledgePorts } from './ports.js';
export { searchKnowledge } from './search.js';
export {
  getKnowledgeEntry,
  selectAllSlugsFromKnowledge,
  selectAlwaysInjectFromKnowledge,
  selectOnDemandSlugsFromKnowledge,
  updateKnowledgeLinks,
} from './service.js';
