/**
 * Memory CRUD: add, update, remove, touch.
 */

import crypto from 'crypto';
import { upsertEmbedding, searchSimilar, removeEmbeddings } from '../../embeddings';
import { getQdrantClient } from '../../embeddings/qdrant';
import type { MemoryRole, MemoryVisibility } from './types';

const COLLECTION_NAME = 'forge_embeddings';

function generateMemoryId(): string {
  return `mem_${crypto.randomBytes(9).toString('base64url')}`;
}

/**
 * Add a memory with semantic dedup. If a similar memory exists (cosine > 0.85),
 * overwrite it instead of creating a duplicate.
 */
export async function addMemory(
  projectId: string,
  userKey: string,
  category: string,
  content: string,
  scope: 'user' | 'project' | 'global' = 'user',
  source = 'auto',
  widgetUserId?: string,
  role: MemoryRole = 'dev',
  visibility: MemoryVisibility = 'all',
): Promise<{ sourceId: string; isUpdate: boolean; degraded?: boolean }> {
  const log = (globalThis as any).strapi?.log;

  let duplicate: import('../../embeddings').SearchResult | undefined;
  try {
    const similar = scope === 'global'
      ? await searchSimilarGlobal(content, 5)
      : await searchSimilar(projectId, content, 5, ['memory']);
    duplicate = similar.find((s) => {
      if (s.score < 0.85) return false;
      const meta = s.payload.metadata || {};
      return scope !== 'user' || meta.userKey === userKey;
    });
  } catch (err) {
    log?.warn?.(`[memory] dedup search failed, proceeding without dedup: ${err}`);
  }

  const now = new Date().toISOString();
  const effectiveProjectId = scope === 'global' ? '__global__' : projectId;

  if (duplicate) {
    const sourceId = duplicate.payload.source_id;
    const oldMeta = duplicate.payload.metadata || {};
    try {
      await upsertEmbedding({
        project_id: effectiveProjectId,
        source_type: 'memory',
        source_id: sourceId,
        text: content,
        metadata: { ...oldMeta, category, scope, source, role, visibility, updatedAt: now },
        contextual: true,
      });
      return { sourceId, isUpdate: true };
    } catch (err) {
      log?.warn?.(`[memory] embedding failed for update, falling back to payload-only: ${err}`);
      const stored = await storeWithoutEmbedding(effectiveProjectId, sourceId, content, {
        ...oldMeta, category, scope, source, role, visibility, updatedAt: now,
      });
      if (!stored) throw new Error(`Failed to store memory: embedding service unavailable and Qdrant fallback failed`);
      return { sourceId, isUpdate: true, degraded: true };
    }
  }

  const sourceId = generateMemoryId();
  const metadata = {
    userKey,
    ...(widgetUserId && { widgetUserId }),
    category, scope, source, role, visibility,
    retrievalCount: 0, createdAt: now, updatedAt: now,
  };
  try {
    await upsertEmbedding({
      project_id: effectiveProjectId,
      source_type: 'memory',
      source_id: sourceId,
      text: content,
      metadata,
      contextual: true,
    });
    return { sourceId, isUpdate: false };
  } catch (err) {
    log?.warn?.(`[memory] embedding failed for insert, falling back to payload-only: ${err}`);
    const stored = await storeWithoutEmbedding(effectiveProjectId, sourceId, content, metadata);
    if (!stored) throw new Error(`Failed to store memory: embedding service unavailable and Qdrant fallback failed`);
    return { sourceId, isUpdate: false, degraded: true };
  }
}

/**
 * Store a memory in Qdrant without an embedding vector (zero vector fallback).
 */
async function storeWithoutEmbedding(
  projectId: string,
  sourceId: string,
  text: string,
  metadata: Record<string, any>,
): Promise<boolean> {
  const qdrant = getQdrantClient();
  if (!qdrant) return false;

  try {
    const vectorSize = parseInt(process.env.QDRANT_VECTOR_SIZE || '1536', 10);
    const pointId = crypto.createHash('sha1').update(`${projectId}:memory:${sourceId}:0`).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    const { buildDocSparseVector, buildMetadataText } = await import('../../embeddings/bm25');
    const metadataText = buildMetadataText(metadata);
    await qdrant.upsert(COLLECTION_NAME, {
      points: [{
        id: pointId,
        vector: {
          dense: new Array(vectorSize).fill(0),
          bm25: buildDocSparseVector(text, metadataText),
        },
        payload: { project_id: projectId, source_type: 'memory', source_id: sourceId, text, chunk_index: 0, metadata },
      }],
    });
    return true;
  } catch (err) {
    const log = (globalThis as any).strapi?.log;
    log?.error?.(`[memory] Qdrant fallback write failed: ${err}`);
    return false;
  }
}

/**
 * Search for similar memories across all projects (global scope).
 */
export async function searchSimilarGlobal(query: string, topK: number): Promise<import('../../embeddings').SearchResult[]> {
  const qdrant = getQdrantClient();
  if (!qdrant) return [];

  const { embed } = await import('../../embeddings');
  const [queryVector] = await embed([query]);

  const results = await qdrant.search(COLLECTION_NAME, {
    vector: { name: 'dense', vector: queryVector },
    limit: topK,
    filter: {
      must: [
        { key: 'source_type', match: { value: 'memory' } },
        { key: 'metadata.scope', match: { value: 'global' } },
      ],
    },
    with_payload: true,
  });

  return results.map((r: any) => ({
    score: r.score,
    payload: r.payload as import('../../embeddings').SearchResult['payload'],
  }));
}

/**
 * Update an existing memory's content and metadata by sourceId.
 */
export async function updateMemoryContent(
  projectId: string,
  sourceId: string,
  newContent: string,
  metadataUpdates: Partial<{ role: MemoryRole; visibility: MemoryVisibility; category: string }> = {},
): Promise<boolean> {
  const qdrant = getQdrantClient();
  if (!qdrant) return false;

  try {
    const results = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'source_type', match: { value: 'memory' } },
          { key: 'source_id', match: { value: sourceId } },
        ],
      },
      with_payload: true,
      limit: 1,
    });
    const point = results.points?.[0];
    if (!point) return false;

    const oldMeta = (point.payload as any)?.metadata || {};
    await upsertEmbedding({
      project_id: projectId,
      source_type: 'memory',
      source_id: sourceId,
      text: newContent,
      metadata: {
        ...oldMeta,
        ...metadataUpdates,
        updatedAt: new Date().toISOString(),
      },
      contextual: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a memory by sourceId.
 */
export async function removeMemory(sourceId: string): Promise<boolean> {
  try {
    await removeEmbeddings('memory', sourceId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Increment retrievalCount on memory points (fire-and-forget).
 */
export async function touchMemories(sourceIds: string[]): Promise<void> {
  const qdrant = getQdrantClient();
  if (!qdrant || sourceIds.length === 0) return;

  try {
    for (const sourceId of sourceIds) {
      const results = await qdrant.scroll(COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'source_type', match: { value: 'memory' } },
            { key: 'source_id', match: { value: sourceId } },
          ],
        },
        with_payload: true,
        limit: 1,
      });
      const point = results.points?.[0];
      if (!point) continue;

      const meta = (point.payload as any)?.metadata || {};
      await qdrant.setPayload(COLLECTION_NAME, {
        payload: {
          metadata: {
            ...meta,
            retrievalCount: (meta.retrievalCount || 0) + 1,
          },
        },
        filter: {
          must: [
            { key: 'source_type', match: { value: 'memory' } },
            { key: 'source_id', match: { value: sourceId } },
          ],
        },
      });
    }
  } catch (err) {
    const log = (globalThis as any).strapi?.log;
    log?.debug?.(`[memory] touchMemories failed: ${err}`);
  }
}
