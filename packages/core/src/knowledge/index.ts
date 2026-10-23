export { runKnowledgeEmbeddingBackfill } from './embedding-backfill.js';
export {
  type DraftEmbedding,
  deleteFeedbackEmbedding,
  EMBEDDING_PROVIDER_NOT_CONFIGURED,
  embedText,
  type ItemEmbeddingStatus,
  itemEmbeddingOf,
  type NearestItem,
  nearestItems,
  unembeddedCounts,
  writeItemEmbedding,
} from './item-embeddings.js';
export {
  type LessonEntry,
  type LessonEntryMeta,
  lessonEntrySlug,
  lessonsMonthSlug,
  putLessonEntry,
  putLessonsMonthEntry,
  selectLessonEntries,
  setLessonEntryInjection,
} from './lesson-entries.js';
export { provideKnowledgePorts } from './ports.js';
export { searchKnowledge } from './search.js';
export {
  type AlwaysInjectFact,
  getKnowledgeEntry,
  selectAllSlugsFromKnowledge,
  selectAlwaysInjectFromKnowledge,
  selectOnDemandSlugsFromKnowledge,
  updateKnowledgeLinks,
} from './service.js';
