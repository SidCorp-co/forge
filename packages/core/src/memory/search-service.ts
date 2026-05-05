import { env } from '../config/env.js';
import type { MemoryRole, MemorySource } from '../db/schema.js';
import { embed } from '../embeddings/index.js';
import { type MemoryHit, searchMemories } from './search.js';

/**
 * Run a semantic memory search. Shared between the `POST /api/memory/search`
 * REST route and the `forge_memory.search` MCP tool (ISS-202) so both surfaces
 * return the exact same shape.
 *
 * Does NOT check authorization — callers must verify project membership
 * before invoking this function.
 */
export interface RunMemorySearchInput {
  projectId: string;
  query: string;
  topK?: number | undefined;
  sourceFilter?: MemorySource[] | undefined;
  allowedRoles?: MemoryRole[] | undefined;
}

export interface MemorySearchResult {
  hits: MemoryHit[];
  model: string;
  took_ms: number;
}

export async function runMemorySearch(input: RunMemorySearchInput): Promise<MemorySearchResult> {
  const startedAt = Date.now();
  const queryVec = await embed(input.query);
  const hits = await searchMemories({
    projectId: input.projectId,
    queryVec,
    topK: input.topK,
    sourceFilter: input.sourceFilter,
    allowedRoles: input.allowedRoles,
  });
  return {
    hits,
    model: env.EMBEDDINGS_MODEL,
    took_ms: Date.now() - startedAt,
  };
}
