export { KNOWLEDGE_REST_CARDS } from './cards.js';
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
export {
  codeAnchorOf,
  entryForMap,
  type MapWriter,
  removeKnowledgeRelation,
  setKnowledgeModule,
  writeKnowledgeRelation,
} from './module-fields.js';
export { orgKnowledgeCreatedAt, orgOnDemandSlugsOf } from './org-knowledge.js';
export { orgKnowledgeRoutes } from './org-knowledge-routes.js';
export { keywordOrgRecall, type OrgRecallHit, semanticOrgRecall } from './org-recall.js';
export {
  findRecords,
  type KnowledgeFoundRecord,
  provideKnowledgePorts,
} from './ports.js';
export {
  type Anchors,
  anchorsMet,
  anchorsOf,
  flagKnowledgeForChange,
  type RecheckChange,
} from './recheck.js';
export {
  type RulingDeciderRead,
  rulingDecidersOf,
} from './ruling-deciders.js';
export {
  type KnowledgeHit,
  keywordSearchKnowledge,
  queryVectorOf,
  searchKnowledge,
} from './search.js';
export {
  type AlwaysInjectFact,
  getKnowledgeEntry,
  type ProjectRuleRead,
  readKnowledgeEntry,
  readProjectRule,
  selectAllSlugsFromKnowledge,
  selectAlwaysInjectFromKnowledge,
  selectOnDemandSlugsFromKnowledge,
  selectOnDemandSourcesFromKnowledge,
  updateKnowledgeLinks,
} from './service.js';
