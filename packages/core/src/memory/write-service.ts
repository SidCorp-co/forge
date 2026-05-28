import { z } from 'zod';
import { memorySources } from '../db/schema.js';
import { type IndexResult, indexMemory } from './indexer.js';

/**
 * Shared service for writing a memory row. Used by REST `POST /api/memory`
 * and MCP `forge_memory.write` so both surfaces validate identically.
 *
 * Does NOT check authorization — callers MUST verify project membership
 * before invoking.
 */

export const writeMemoryInputSchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memorySources),
  // `sourceRef` is the unique natural key paired with (projectId, source).
  // Bounded length keeps the unique-constraint index small; 512 matches the
  // REST DELETE schema in list-routes.ts.
  sourceRef: z.string().trim().min(1).max(512),
  // Embedding service consumes the raw text. The indexer truncates to
  // MAX_EMBED_CHARS internally (8192) and reports it via `truncated` in the
  // result so callers can surface the trim.
  textContent: z.string().trim().min(1).max(100_000),
  // Free-form metadata stored on the row. Used by `metadataFilter` containment
  // queries in `forge_memory.search` / `forge_memory.get`. Keep values JSON-
  // serializable; nested structures are allowed.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type WriteMemoryInput = z.infer<typeof writeMemoryInputSchema>;

export type WriteMemoryResult = IndexResult;

export async function runMemoryWrite(input: WriteMemoryInput): Promise<WriteMemoryResult> {
  return indexMemory({
    projectId: input.projectId,
    source: input.source,
    sourceRef: input.sourceRef,
    text: input.textContent,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });
}
