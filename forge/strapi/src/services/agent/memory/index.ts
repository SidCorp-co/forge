/**
 * Memory Layer — Qdrant-only storage (Mem0-style).
 * Memories are embedded as source_type: "memory" in the shared forge_embeddings collection.
 * Retrieved by vector similarity through the RAG pipeline, not dumped into every prompt.
 */

// Types & constants
export {
  type MemoryRole,
  type MemoryVisibility,
  type MemoryEntry,
  type SearchMemoriesOptions,
  type SearchMemoryEntry,
  type ListMemoriesOptions,
  SKILL_MEMORY_ROLES,
  isVisibleTo,
} from './types';

// CRUD
export {
  addMemory,
  updateMemoryContent,
  removeMemory,
  touchMemories,
} from './crud';

// Search & list
export {
  searchMemories,
  listMemories,
  exportMemoriesAsMarkdown,
} from './search';

// Extraction
export {
  extractMemories,
  extractToolPatterns,
} from './extraction';

// Re-export type from sibling
export type { RetrievalStrategy } from '../retrieval-strategy';
