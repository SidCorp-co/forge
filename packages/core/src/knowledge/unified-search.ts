import { EmbeddingUnavailableError, embed } from '../integrations/embeddings/index.js';
import type { MemoryHit } from '../memory/index.js';
import { runMemorySearch } from '../memory/index.js';
import { logger } from '../observability/logger.js';
import type { KnowledgeHit } from './search.js';
import { hybridSearchKnowledge, keywordSearchKnowledge, searchKnowledge } from './search.js';

type UnifiedScope = 'knowledge' | 'memory' | 'all';
type UnifiedStrategy = 'semantic' | 'keyword' | 'hybrid';

interface KnowledgeHitLabeled extends KnowledgeHit {
  origin: 'knowledge';
}

interface MemoryHitLabeled extends MemoryHit {
  origin: 'memory';
}

interface UnifiedSearchResult {
  knowledge: KnowledgeHitLabeled[];
  memory: MemoryHitLabeled[];
  degraded?: boolean;
}

type Needs = {
  projectId: string;
  query: string;
  topK: number | undefined;
  knowledge: boolean;
  memory: boolean;
};

const labelKnowledge = (hits: KnowledgeHit[]) =>
  hits.map((h) => ({ ...h, origin: 'knowledge' as const }));
const labelMemory = (hits: MemoryHit[]) => hits.map((h) => ({ ...h, origin: 'memory' as const }));

/** Both stores by keyword alone — the `keyword` strategy, and what the others degrade to. */
async function keywordOnly(needs: Needs): Promise<UnifiedSearchResult> {
  const { projectId, query, topK } = needs;
  const knowledge = needs.knowledge
    ? labelKnowledge(await keywordSearchKnowledge(projectId, query, topK))
    : [];
  const memory = needs.memory
    ? labelMemory(
        (await runMemorySearch({ projectId, query, topK, strategy: 'keyword', surface: 'agent' }))
          .hits,
      )
    : [];
  return { knowledge, memory };
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
  const needs: Needs = {
    projectId,
    query,
    topK,
    knowledge: scope === 'knowledge' || scope === 'all',
    memory: scope === 'memory' || scope === 'all',
  };
  if (strategy === 'keyword') return keywordOnly(needs);

  let queryVec: number[];
  try {
    queryVec = await embed({ surface: 'knowledge' }, query);
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    logger.warn(
      { projectId, scope, strategy },
      'knowledge.unified-search: embeddings unavailable, degrading to keyword',
    );
    return { ...(await keywordOnly(needs)), degraded: true };
  }

  const [knowledge, memory] = await Promise.all([
    needs.knowledge
      ? (strategy === 'hybrid'
          ? hybridSearchKnowledge(projectId, queryVec, query, topK)
          : searchKnowledge(projectId, queryVec, topK)
        ).then(labelKnowledge)
      : [],
    needs.memory
      ? runMemorySearch({ projectId, query, queryVec, topK, strategy, surface: 'agent' })
      : undefined,
  ]);
  return {
    knowledge,
    memory: memory ? labelMemory(memory.hits) : [],
    ...(memory?.degraded ? { degraded: true } : {}),
  };
}
