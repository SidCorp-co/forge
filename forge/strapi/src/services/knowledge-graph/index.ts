/**
 * Knowledge Graph — lightweight edge storage for entity relationships.
 * Stored in Strapi DB (knowledge_edges table), queried for multi-hop traversal (up to 3 hops).
 * Uses Personalized PageRank to score entities by relevance during traversal.
 */

import { personalizedPageRank } from './pagerank';
import { extractEntitiesAndEdges } from './entity-extractor';
import type { ExtractionSource } from './entity-extractor';
import { EDGE_UID, upsertEdge } from './edge-store';
import type { EdgeInput, KnowledgeEdge } from './edge-store';

// Re-export edge primitives for consumers that import from 'knowledge-graph'
export { upsertEdge, EDGE_UID };
export type { EdgeInput, KnowledgeEdge };

/**
 * Query edges for given entities (1-hop by default, up to 3 hops).
 * Returns all active edges (validUntil IS NULL) where entity appears as subject or object.
 */
export async function queryEdges(
  strapi: any,
  projectId: string,
  entities: string[],
  hops = 1,
): Promise<KnowledgeEdge[]> {
  if (entities.length === 0) return [];

  const docs = strapi.documents(EDGE_UID);
  const normalized = entities.map((e) => e.toLowerCase().trim()).filter(Boolean);
  const seenEdges = new Set<string>();
  const seenEntities = new Set<string>(normalized);
  let allEdges: KnowledgeEdge[] = [];

  // Resolve project's internal DB id once for raw queries
  const projectRow = await strapi.db.query('api::project.project').findOne({
    where: { documentId: projectId },
    select: ['id'],
  });
  const projectDbId = projectRow?.id;
  if (!projectDbId) return [];

  let currentEntities = normalized;
  for (let hop = 0; hop < Math.min(hops, 3); hop++) {
    if (currentEntities.length === 0) break;

    // Use DB query layer with $or + $containsi for efficient SQL LIKE substring matching.
    // This scales with the graph — only matching rows are returned, not the entire table.
    const orConditions = currentEntities.flatMap((e) => [
      { subject: { $containsi: e } },
      { object: { $containsi: e } },
    ]);

    const edges = await strapi.db.query(EDGE_UID).findMany({
      where: {
        project: projectDbId,
        validUntil: null,
        $or: orConditions,
      },
      limit: 50,
    });

    const nextEntities = new Set<string>();
    for (const edge of edges) {
      const key = `${edge.subject}:${edge.predicate}:${edge.object}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      allEdges.push(edge as KnowledgeEdge);

      // Collect new entities for next hop (dedup across all hops)
      if (!seenEntities.has(edge.subject)) {
        nextEntities.add(edge.subject);
        seenEntities.add(edge.subject);
      }
      if (!seenEntities.has(edge.object)) {
        nextEntities.add(edge.object);
        seenEntities.add(edge.object);
      }
    }

    // Cap fan-out per hop to prevent query explosion on dense graphs
    currentEntities = Array.from(nextEntities).slice(0, 20);
  }

  return allEdges;
}

// --- Multi-hop graph context with PageRank scoring ---

export interface GraphContext {
  edges: KnowledgeEdge[];
  scores: Map<string, number>;
  entities: string[];
}

/**
 * Query graph context: multi-hop traversal + Personalized PageRank scoring.
 * Returns edges sorted by PageRank relevance, limited to top 30.
 */
export async function queryGraphContext(
  strapi: any,
  projectId: string,
  seedEntities: string[],
  hops = 2,
): Promise<GraphContext> {
  const edges = await queryEdges(strapi, projectId, seedEntities, hops);
  if (edges.length === 0) {
    return { edges: [], scores: new Map(), entities: [] };
  }

  // Seeds must be lowercase to match edge subjects/objects from queryEdges
  const seeds = seedEntities.map((e) => e.toLowerCase().trim());
  const scores = personalizedPageRank(edges, seeds);

  // Sort edges by max PageRank score of their subject/object
  const sorted = edges
    .map((edge) => ({
      edge,
      score: Math.max(scores.get(edge.subject) ?? 0, scores.get(edge.object) ?? 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((e) => e.edge);

  // Collect all unique entities from scored results
  const entities = Array.from(scores.keys());

  return { edges: sorted, scores, entities };
}

/**
 * Format graph context with PageRank scores for injection into system prompt.
 */
export function formatGraphContextForPrompt(ctx: GraphContext): string {
  if (ctx.edges.length === 0) return '';
  const lines = ctx.edges.map((e) => {
    const score = Math.max(ctx.scores.get(e.subject) ?? 0, ctx.scores.get(e.object) ?? 0);
    const val = e.value ? `: ${e.value}` : '';
    return `- [${score.toFixed(2)}] ${e.subject} —${e.predicate}→ ${e.object}${val}`;
  });
  return lines.join('\n');
}

// --- Graph-based memory retrieval ---

/**
 * Find memories connected via knowledge graph traversal.
 * Extracts entities from query → multi-hop graph traversal → collects sourceMemoryId →
 * scrolls Qdrant for those memory embeddings → returns as SearchResult[].
 */
export async function findMemoriesByGraph(
  strapi: any,
  projectId: string,
  query: string,
  limit = 15,
): Promise<import('../embeddings').SearchResult[]> {
  const { extractEntities, searchByEntities } = await import('../entity-index');

  const keywords = extractEntities(query).slice(0, 10);
  if (keywords.length === 0) return [];

  const ctx = await queryGraphContext(strapi, projectId, keywords, 2);
  if (ctx.edges.length === 0 && ctx.entities.length === 0) return [];

  // Strategy 1: Search memories by graph-discovered entities (entity keyword match in Qdrant)
  const graphEntities = ctx.entities.slice(0, 15);
  const allKeywords = Array.from(new Set([...keywords, ...graphEntities]));
  const entityResults = await searchByEntities(projectId, allKeywords);
  const memoryResults = entityResults.filter((r) => r.payload.source_type === 'memory');

  // Strategy 2: Also collect memories referenced by sourceMemoryId in edges
  const memorySourceIds = new Set<string>();
  for (const edge of ctx.edges) {
    if (edge.sourceMemoryId?.startsWith('memory:')) {
      memorySourceIds.add(edge.sourceMemoryId.replace('memory:', ''));
    }
  }

  if (memorySourceIds.size > 0) {
    try {
      const { getQdrantClient } = await import('../embeddings/qdrant');
      const qdrant = getQdrantClient();
      if (qdrant) {
        const sourceIds = Array.from(memorySourceIds).slice(0, limit);
        const scrollResult = await qdrant.scroll('forge_embeddings', {
          filter: {
            must: [
              { key: 'project_id', match: { value: projectId } },
              { key: 'source_type', match: { value: 'memory' } },
              { key: 'source_id', match: { any: sourceIds } },
            ],
          },
          limit,
          with_payload: true,
          with_vector: false,
        });
        const seenIds = new Set(memoryResults.map((r) => r.payload.source_id));
        for (const point of scrollResult.points || []) {
          const payload = point.payload as any;
          if (!seenIds.has(payload.source_id)) {
            memoryResults.push({
              score: 0.5,
              payload: {
                source_type: 'memory',
                source_id: payload.source_id || '',
                text: payload.text || '',
                project_id: payload.project_id || projectId,
                chunk_index: payload.chunk_index || 0,
                metadata: payload.metadata || {},
              },
            });
          }
        }
      }
    } catch {
      // Non-fatal: entity search already provides results
    }
  }

  // Score by PageRank relevance of connected entities
  return memoryResults
    .map((r) => {
      const memEntities = ((r.payload as any).entities || []) as string[];
      const maxScore = memEntities.reduce(
        (max: number, e: string) => Math.max(max, ctx.scores.get(e.toLowerCase()) ?? 0),
        0.5,
      );
      return { ...r, score: maxScore };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// --- LLM-based edge extraction (delegates to unified extractor) ---

/**
 * Extract knowledge graph edges from an issue using unified LLM extractor.
 * Fire-and-forget, non-blocking.
 */
export async function extractIssueEdges(
  strapi: any,
  projectId: string,
  issue: { documentId: string; title: string; description?: string; category?: string; acceptanceCriteria?: string },
): Promise<number> {
  const desc = (issue.description || '').slice(0, 600);
  if (desc.length < 30) return 0;

  const source: ExtractionSource = {
    type: 'issue',
    text: desc,
    sourceId: issue.documentId,
    metadata: {
      title: issue.title,
      category: issue.category,
      acceptanceCriteria: issue.acceptanceCriteria,
    },
  };

  const result = await extractEntitiesAndEdges(strapi, projectId, source);
  return result.edgesStored;
}

// --- Issue relation sync to knowledge edges ---

interface IssueRelation {
  type: string;
  targetDocumentId: string;
  reason?: string;
}

/**
 * Sync issue relations to knowledge edges for unified graph traversal.
 * One-way sync: issue relations field → knowledge edges table.
 */
export async function syncRelationsToEdges(
  strapi: any,
  projectId: string,
  issueDocId: string,
  relations: IssueRelation[],
): Promise<number> {
  if (!relations?.length) return 0;

  let count = 0;
  for (const rel of relations) {
    if (!rel.targetDocumentId || !rel.type) continue;

    await upsertEdge(strapi, projectId, {
      subject: issueDocId,
      predicate: rel.type,
      object: rel.targetDocumentId,
      value: rel.reason || undefined,
      sourceMemoryId: `issue-relation:${issueDocId}`,
    });
    count++;
  }

  if (count > 0) {
    strapi.log.info(`[knowledge-graph] synced ${count} issue relations to edges for ${issueDocId}`);
  }
  return count;
}

// --- Edge lifecycle management ---

/**
 * Invalidate edges by source (set validUntil to now).
 * Used when a memory is pruned or a source is deleted.
 */
export async function invalidateEdgesBySource(
  strapi: any,
  projectId: string,
  sourceMemoryId: string,
): Promise<number> {
  const docs = strapi.documents(EDGE_UID);
  const edges = await docs.findMany({
    filters: {
      project: { documentId: { $eq: projectId } },
      sourceMemoryId: { $eq: sourceMemoryId },
      validUntil: { $null: true },
    },
    limit: 50,
  });

  const now = new Date().toISOString();
  let count = 0;

  for (const edge of edges) {
    await docs.update({
      documentId: edge.documentId,
      data: { validUntil: now },
    });
    count++;
  }

  if (count > 0) {
    strapi.log.info(`[knowledge-graph] invalidated ${count} edges for source ${sourceMemoryId}`);
  }
  return count;
}

