// Recall as a filter of the find door (ISS-1256): what `POST /api/projects/:id/knowledge/search` and
// `forge_knowledge search` answer, the door's knowledge and memory arms alone, in the shape those
// callers read (two lists, their scores never blended across them). The query expands through the
// glossary as every find does, so an alias recalls its term here too. The strategy a caller names
// picks the arms: `semantic` the dense, `keyword` the keyword, `hybrid` both fused by rank.

import { queryVectorOf } from '../knowledge/index.js';
import type { ProjectReader } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { clampTopK, fuseHybrid } from '../lib/search-fusion.js';
import { runMemorySearch } from '../memory/index.js';
import { type KnowledgeRecallHit, keywordKnowledge, semanticKnowledge } from './arms-knowledge.js';
import { expandedText, expandThroughGlossary } from './expand.js';
import { glossaryTerms } from './model-reads.js';

type RecallStrategy = 'semantic' | 'keyword' | 'hybrid';

export interface FindRecallInput {
  projectId: string;
  /** Who reads: a memory hit's cite in a project they may not read is never read (REQ-30 BC-10). */
  reader: ProjectReader;
  query: string;
  scope: 'knowledge' | 'memory' | 'all';
  topK?: number;
  strategy?: RecallStrategy;
}

type MemoryRecallHit = Awaited<ReturnType<typeof runMemorySearch>>['hits'][number] & {
  origin: 'memory';
};

export interface FindRecall {
  knowledge: KnowledgeRecallHit[];
  memory: MemoryRecallHit[];
  degraded?: boolean;
}

async function memoryOf(
  input: FindRecallInput,
  strategy: RecallStrategy,
  queryVec: number[] | undefined,
): Promise<{ hits: MemoryRecallHit[]; degraded: boolean }> {
  const found = await runMemorySearch({
    projectId: input.projectId,
    query: input.query,
    topK: input.topK,
    strategy,
    ...(queryVec ? { queryVec } : {}),
    surface: 'agent',
    reader: input.reader,
  });
  return {
    hits: found.hits.map((h) => ({ ...h, origin: 'memory' as const })),
    degraded: found.degraded === true,
  };
}

/** The project's knowledge, its org's rulings and its curated memory, recalled for one query. */
export async function recallThroughFind(input: FindRecallInput): Promise<FindRecall> {
  const { projectId, query, scope, strategy = 'semantic' } = input;
  const k = clampTopK(input.topK);
  const knowledgeWanted = scope !== 'memory';
  const memoryWanted = scope !== 'knowledge';
  const named = knowledgeWanted
    ? expandThroughGlossary(query, await glossaryTerms([projectId]))
    : [];
  const text = expandedText(query, named);
  const keywordOnly = async (degraded: boolean): Promise<FindRecall> => {
    const [knowledge, memory] = await Promise.all([
      knowledgeWanted ? keywordKnowledge([projectId], text, k) : [],
      memoryWanted ? memoryOf(input, 'keyword', undefined) : null,
    ]);
    return { knowledge, memory: memory?.hits ?? [], ...(degraded ? { degraded: true } : {}) };
  };
  if (strategy === 'keyword') return keywordOnly(false);

  const queryVec = await queryVectorOf(query);
  if (!queryVec) {
    logger.warn(
      { projectId, scope, strategy },
      'find recall: embeddings unavailable, keyword only',
    );
    return keywordOnly(true);
  }
  const knowledgeOf = async () => {
    const semantic = await semanticKnowledge([projectId], queryVec, k);
    if (strategy === 'semantic') return semantic;
    return fuseHybrid<KnowledgeRecallHit>(
      semantic,
      await keywordKnowledge([projectId], text, k),
      k,
    );
  };
  const [knowledge, memory] = await Promise.all([
    knowledgeWanted ? knowledgeOf() : [],
    memoryWanted ? memoryOf(input, strategy, queryVec) : null,
  ]);
  return {
    knowledge,
    memory: memory?.hits ?? [],
    ...(memory?.degraded ? { degraded: true } : {}),
  };
}
