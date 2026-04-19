/**
 * Memory search, list, and export.
 */

import { searchSimilar } from '../../embeddings';
import { crossEncoderRerank } from '../../embeddings/cross-encoder';
import { getQdrantClient } from '../../embeddings/qdrant';
import {
  type MemoryRole, type MemoryVisibility, type MemoryEntry,
  type SearchMemoriesOptions, type SearchMemoryEntry, type ListMemoriesOptions,
  CATEGORY_TO_TYPE, isVisibleTo,
} from './types';
import { searchSimilarGlobal, touchMemories } from './crud';

const COLLECTION_NAME = 'forge_embeddings';

/**
 * Search for memories using the specified retrieval strategy.
 * Defaults to 'hybrid' (RRF fusion). Falls back to semantic-only for the legacy path.
 */
export async function searchMemories(
  projectId: string,
  query: string,
  options?: SearchMemoriesOptions,
): Promise<SearchMemoryEntry[]> {
  const limit = options?.limit || 5;
  const strategy = options?.strategy || 'hybrid';

  try {
    let results: import('../../embeddings').SearchResult[];

    if (strategy !== 'semantic') {
      const { executeStrategy } = await import('../retrieval-strategy');
      const strapi = (globalThis as any).strapi;
      const { results: stratResults } = await executeStrategy(
        strapi, projectId, query, strategy,
        { limit: limit * 3, sourceTypes: ['memory'] },
      );
      results = stratResults;
    } else {
      results = await searchSimilar(projectId, query, limit * 3, ['memory']);
    }

    if (strategy === 'semantic' && (options?.includeGlobal || options?.allowedRoles?.includes('ceo'))) {
      const globalResults = await searchSimilarGlobal(query, limit * 2);
      results = [...results, ...globalResults];
      results.sort((a, b) => b.score - a.score);
    }

    if (strategy === 'semantic') {
      const ceResults = await crossEncoderRerank(query, results, limit * 2);
      if (ceResults) {
        results = ceResults;
      }
    }

    let entries: SearchMemoryEntry[] = results.map((r) => {
      const meta = r.payload.metadata || {};
      return {
        sourceId: r.payload.source_id || '',
        category: meta.category || 'unknown',
        content: r.payload.text || '',
        scope: meta.scope || 'user',
        source: meta.source || 'auto',
        userKey: meta.userKey || '',
        retrievalCount: meta.retrievalCount || 0,
        role: meta.role || '',
        visibility: meta.visibility || '',
        createdAt: meta.createdAt || '',
        updatedAt: meta.updatedAt || '',
        score: (r as any).crossEncoderScore ?? r.score,
      };
    });

    if (options?.allowedRoles?.length) {
      const allowed = options.allowedRoles;
      entries = entries.filter((e) => {
        if (!e.role) return true;
        if (!allowed.includes(e.role as MemoryRole)) return false;
        if (!e.visibility || e.visibility === 'all') return true;
        return isVisibleTo(e.role as MemoryRole, e.visibility as MemoryVisibility, allowed);
      });
    }

    const capped = entries.slice(0, limit);

    const sourceIds = capped.map((e) => e.sourceId).filter(Boolean);
    if (sourceIds.length) touchMemories(sourceIds);

    return capped;
  } catch (err) {
    const log = (globalThis as any).strapi?.log;
    log?.warn?.(`[memory] searchMemories failed: ${err}`);
    return [];
  }
}

/**
 * List all memories for a user in a project (for forge_memory tool "list" action).
 */
export async function listMemories(
  projectId: string,
  userKey: string,
  options?: ListMemoriesOptions,
): Promise<MemoryEntry[]> {
  const qdrant = getQdrantClient();
  if (!qdrant) return [];

  try {
    const result = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'project_id', match: { value: projectId } },
          { key: 'source_type', match: { value: 'memory' } },
        ],
        should: [
          { key: 'metadata.userKey', match: { value: userKey } },
          { key: 'metadata.scope', match: { value: 'project' } },
        ],
      },
      with_payload: true,
      limit: 100,
    });

    let points = result.points || [];

    if (options?.includeGlobal || options?.allowedRoles?.includes('ceo')) {
      const globalResult = await qdrant.scroll(COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'project_id', match: { value: '__global__' } },
            { key: 'source_type', match: { value: 'memory' } },
          ],
        },
        with_payload: true,
        limit: 50,
      });
      points = [...points, ...(globalResult.points || [])];
    }

    let entries = points.map((p) => {
      const meta = (p.payload as any)?.metadata || {};
      return {
        sourceId: (p.payload as any)?.source_id || '',
        category: meta.category || 'unknown',
        content: (p.payload as any)?.text || '',
        scope: meta.scope || 'user',
        source: meta.source || 'auto',
        userKey: meta.userKey || '',
        retrievalCount: meta.retrievalCount || 0,
        role: meta.role || '',
        visibility: meta.visibility || '',
        createdAt: meta.createdAt || '',
        updatedAt: meta.updatedAt || '',
      };
    });

    if (options?.allowedRoles?.length) {
      const allowed = options.allowedRoles;
      entries = entries.filter((e) => {
        if (!e.role) return true;
        if (!allowed.includes(e.role as MemoryRole)) return false;
        if (!e.visibility || e.visibility === 'all') return true;
        return isVisibleTo(e.role as MemoryRole, e.visibility as MemoryVisibility, allowed);
      });
    }

    return entries;
  } catch (err) {
    const log = (globalThis as any).strapi?.log;
    log?.warn?.(`[memory] listMemories failed: ${err}`);
    return [];
  }
}

/**
 * Export memories as MEMORY.md-compatible markdown.
 */
export function exportMemoriesAsMarkdown(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return '# Forge Memory Sync\n\nNo memories synced.';
  }

  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const cat = entry.category || 'unknown';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(entry);
  }

  const indexLines: string[] = ['# Forge Memory Sync', ''];
  for (const [category, items] of groups) {
    const type = CATEGORY_TO_TYPE[category] || 'project';
    indexLines.push(`## ${category} (${type})`);
    for (const item of items) {
      const preview = item.content.length > 120
        ? item.content.slice(0, 117) + '...'
        : item.content;
      const meta = [item.role, item.scope, item.visibility].filter(Boolean).join('/');
      indexLines.push(`- [${meta}] ${preview}`);
    }
    indexLines.push('');
  }

  const detailLines: string[] = ['---', ''];
  for (const [category, items] of groups) {
    const type = CATEGORY_TO_TYPE[category] || 'project';
    detailLines.push(`## ${category}`);
    detailLines.push('');
    for (const item of items) {
      detailLines.push('```yaml');
      detailLines.push(`id: ${item.sourceId}`);
      detailLines.push(`type: ${type}`);
      detailLines.push(`role: ${item.role || 'unknown'}`);
      detailLines.push(`visibility: ${item.visibility || 'all'}`);
      detailLines.push(`scope: ${item.scope || 'user'}`);
      detailLines.push('```');
      detailLines.push('');
      detailLines.push(item.content);
      detailLines.push('');
    }
  }

  return [...indexLines, ...detailLines].join('\n');
}
