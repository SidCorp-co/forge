import { EmbeddingUnavailableError, embed } from '../integrations/llm/index.js';
import type { ProjectReader } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { clampTopK, fuseHybrid } from '../lib/search-fusion.js';
import { keywordOrgRecall, type OrgRecallHit, semanticOrgRecall } from './org-recall.js';
import { knowledgePort } from './ports.js';
import type { KnowledgeHit } from './search.js';
import { hybridSearchKnowledge, keywordSearchKnowledge, searchKnowledge } from './search.js';

type UnifiedScope = 'knowledge' | 'memory' | 'all';
type UnifiedStrategy = 'semantic' | 'keyword' | 'hybrid';

/**
 * A knowledge hit as recall answers it (REQ-89 BC-7, ISS-1121): the project's own entry or a lesson
 * (`origin: 'project'`), or a ruling of its org (`origin: 'org'`), ranked in one list, each with its
 * type, scope, re-check and any re-check flagged on it. A retired, superseded or withdrawn entry is
 * never one.
 */
type KnowledgeRecallHit = (KnowledgeHit & { origin: 'project' }) | OrgRecallHit;

type MemoryHitLabeled = { id: string; origin: 'memory' };

interface UnifiedSearchResult {
  knowledge: KnowledgeRecallHit[];
  memory: MemoryHitLabeled[];
  degraded?: boolean;
}

type Needs = {
  projectId: string;
  reader: ProjectReader;
  query: string;
  topK: number | undefined;
  knowledge: boolean;
  memory: boolean;
};

const own = (hits: KnowledgeHit[]) => hits.map((h) => ({ ...h, origin: 'project' as const }));
const labelMemory = (hits: { id: string }[]) =>
  hits.map((h) => ({ ...h, origin: 'memory' as const }));

/** Both orders of one kind of score merged into one: cosine beside cosine, sorted. */
const byScore = (a: KnowledgeRecallHit[], b: KnowledgeRecallHit[], k: number) =>
  [...a, ...b].sort((x, y) => y.score - x.score).slice(0, k);

/** The project's keyword hits and its org's ranked together by rank, since their scores differ in kind. */
async function keywordKnowledge(projectId: string, query: string, k: number) {
  const [mine, org] = await Promise.all([
    keywordSearchKnowledge(projectId, query, k),
    keywordOrgRecall([projectId], query, k),
  ]);
  return fuseHybrid<KnowledgeRecallHit>(own(mine), org, k);
}

/** Both stores by keyword alone — the `keyword` strategy, and what the others degrade to. */
async function keywordOnly(needs: Needs): Promise<UnifiedSearchResult> {
  const { projectId, query, topK, reader } = needs;
  const knowledge = needs.knowledge
    ? await keywordKnowledge(projectId, query, clampTopK(topK))
    : [];
  const memory = needs.memory
    ? labelMemory(
        (
          await knowledgePort('searchMemory')({
            projectId,
            query,
            topK,
            strategy: 'keyword',
            surface: 'agent',
            reader,
          })
        ).hits,
      )
    : [];
  return { knowledge, memory };
}

async function embeddedKnowledge(
  projectId: string,
  queryVec: number[],
  query: string,
  topK: number | undefined,
  strategy: 'semantic' | 'hybrid',
): Promise<KnowledgeRecallHit[]> {
  const k = clampTopK(topK);
  const [mine, org] = await Promise.all([
    strategy === 'hybrid'
      ? hybridSearchKnowledge(projectId, queryVec, query, k)
      : searchKnowledge(projectId, queryVec, k),
    semanticOrgRecall([projectId], queryVec, k),
  ]);
  if (strategy === 'semantic') return byScore(own(mine), org ?? [], k);
  // hybrid: the org's cosine and keyword orders fused as the project's are, then the two ranked
  const orgFused = fuseHybrid<KnowledgeRecallHit>(
    org ?? [],
    await keywordOrgRecall([projectId], query, k),
    k,
  );
  return byScore(own(mine), orgFused, k);
}

/**
 * Unified search across the project's knowledge, its org's rulings, and its curated memory: the one
 * read `POST /api/projects/:id/knowledge/search`, `forge_knowledge` `search` and MCP `search` share.
 * The stores answer in two lists and their scores are NOT blended across them.
 */
export async function runUnifiedSearch(input: {
  projectId: string;
  /** Who reads: a memory hit's cite in a project they may not read is never read (REQ-30 BC-10). */
  reader: ProjectReader;
  query: string;
  scope: UnifiedScope;
  topK?: number;
  strategy?: UnifiedStrategy;
}): Promise<UnifiedSearchResult> {
  const { projectId, reader, query, scope, topK, strategy = 'semantic' } = input;
  const needs: Needs = {
    projectId,
    reader,
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
    needs.knowledge ? embeddedKnowledge(projectId, queryVec, query, topK, strategy) : [],
    needs.memory
      ? knowledgePort('searchMemory')({
          projectId,
          query,
          queryVec,
          topK,
          strategy,
          surface: 'agent',
          reader,
        })
      : undefined,
  ]);
  return {
    knowledge,
    memory: memory ? labelMemory(memory.hits) : [],
    ...(memory?.degraded ? { degraded: true } : {}),
  };
}

/**
 * Knowledge recalled across several projects at once, for a door that searches every project its
 * reader reads (MCP `search`): their entries and lessons and their orgs' rulings, ranked by cosine,
 * else by keyword where the query could not be embedded.
 */
export async function recallKnowledgeAcross(
  projectIds: readonly string[],
  query: string,
  topK: number,
): Promise<KnowledgeRecallHit[]> {
  if (projectIds.length === 0) return [];
  try {
    const queryVec = await embed({ surface: 'knowledge' }, query);
    const [mine, org] = await Promise.all([
      searchKnowledge(projectIds, queryVec, topK),
      semanticOrgRecall(projectIds, queryVec, topK),
    ]);
    return byScore(own(mine), org ?? [], topK);
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    return keywordOrgRecall(projectIds, query, topK);
  }
}
