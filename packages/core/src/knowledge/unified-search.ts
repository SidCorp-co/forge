import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { logger } from '../logger.js';
import { runMemorySearch } from '../memory/search-service.js';
import type { MemoryHit } from '../memory/search.js';
import type { KnowledgeHit } from './search.js';
import { hybridSearchKnowledge, keywordSearchKnowledge, searchKnowledge } from './search.js';

export type UnifiedScope = 'knowledge' | 'memory' | 'all';
export type UnifiedStrategy = 'semantic' | 'keyword' | 'hybrid';

export interface KnowledgeHitLabeled extends KnowledgeHit {
  origin: 'knowledge';
}

export interface MemoryHitLabeled extends MemoryHit {
  origin: 'memory';
}

export interface UnifiedSearchResult {
  knowledge: KnowledgeHitLabeled[];
  memory: MemoryHitLabeled[];
  degraded?: boolean;
}

/**
 * Unified search across knowledge_entries and/or memories.
 * Each store is queried independently — scores are NOT blended across stores.
 * Each hit carries `origin` so callers can distinguish source.
 */
export async function runUnifiedSearch(input: {
  projectId: string;
  query: string;
  scope: UnifiedScope;
  topK?: number;
  strategy?: UnifiedStrategy;
}): Promise<UnifiedSearchResult> {
  const { projectId, query, scope, topK, strategy = 'semantic' } = input;

  const knowledgeHits: KnowledgeHitLabeled[] = [];
  const memoryHits: MemoryHitLabeled[] = [];
  let degraded = false;

  const needsKnowledge = scope === 'knowledge' || scope === 'all';
  const needsMemory = scope === 'memory' || scope === 'all';

  if (strategy === 'keyword') {
    if (needsKnowledge) {
      const hits = await keywordSearchKnowledge(projectId, query, topK);
      knowledgeHits.push(...hits.map((h) => ({ ...h, origin: 'knowledge' as const })));
    }
    if (needsMemory) {
      const result = await runMemorySearch({ projectId, query, topK, strategy: 'keyword' });
      memoryHits.push(...result.hits.map((h) => ({ ...h, origin: 'memory' as const })));
    }
    return { knowledge: knowledgeHits, memory: memoryHits };
  }

  // Semantic or hybrid — need an embedding.
  let queryVec: number[] | null = null;
  try {
    queryVec = await embed(query);
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    // Degrade to keyword for all sub-queries.
    logger.warn(
      { projectId, scope, strategy },
      'knowledge.unified-search: embeddings unavailable, degrading to keyword',
    );
    degraded = true;
  }

  if (degraded || queryVec === null) {
    if (needsKnowledge) {
      const hits = await keywordSearchKnowledge(projectId, query, topK);
      knowledgeHits.push(...hits.map((h) => ({ ...h, origin: 'knowledge' as const })));
    }
    if (needsMemory) {
      const result = await runMemorySearch({ projectId, query, topK, strategy: 'keyword' });
      memoryHits.push(...result.hits.map((h) => ({ ...h, origin: 'memory' as const })));
    }
    return { knowledge: knowledgeHits, memory: memoryHits, degraded: true };
  }

  // Run both stores in parallel (no cross-store dedup or score blending).
  const tasks: Promise<void>[] = [];

  if (needsKnowledge) {
    tasks.push(
      (strategy === 'hybrid'
        ? hybridSearchKnowledge(projectId, queryVec, query, topK)
        : searchKnowledge(projectId, queryVec, topK)
      ).then((hits) => {
        knowledgeHits.push(...hits.map((h) => ({ ...h, origin: 'knowledge' as const })));
      }),
    );
  }

  if (needsMemory) {
    tasks.push(
      runMemorySearch({ projectId, query, topK, strategy }).then((result) => {
        memoryHits.push(...result.hits.map((h) => ({ ...h, origin: 'memory' as const })));
        if (result.degraded) degraded = true;
      }),
    );
  }

  await Promise.all(tasks);
  return { knowledge: knowledgeHits, memory: memoryHits, ...(degraded ? { degraded } : {}) };
}
