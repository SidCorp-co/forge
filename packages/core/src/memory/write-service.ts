import { z } from 'zod';
import { memorySources } from '../db/schema.js';
import { type IndexResult, MAX_EMBED_CHARS, indexMemory } from './indexer.js';

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

/**
 * Sources where agents author free-form content and near-duplicates
 * accumulate without semantic dedup. Lifecycle mirrors (issue/decision/
 * policy) track their source records 1:1 and must never be merged.
 */
const SEMANTIC_DEDUP_SOURCES = new Set<string>(['note', 'knowledge']);

export class MemoryWriteValidationError extends Error {}

/**
 * Sources where the text is authored by an agent for future recall (as
 * opposed to lifecycle mirrors of issues/comments/jobs/pm-decisions, whose
 * content mirrors an external record verbatim). Only these get the quality
 * guard below.
 */
const AGENT_AUTHORED_SOURCES = new Set<string>(['note', 'knowledge', 'policy']);

/**
 * Longest fenced code block a memory may carry. Memory stores invariants +
 * pointers, not code — copied code is a second source of truth that rots on
 * the next commit. Short blocks stay allowed for runnable one-liners
 * (verify commands, queries).
 */
const MAX_CODE_BLOCK_LINES = 5;

/** Returns the line count of the longest fenced (```/~~~) block, 0 if none. */
function longestFencedBlockLines(text: string): number {
  let longest = 0;
  let openFence: string | null = null;
  let blockLines = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimStart();
    const fence = line.match(/^(`{3,}|~{3,})/)?.[1] ?? null;
    if (openFence === null) {
      if (fence) {
        openFence = fence[0] === '`' ? '```' : '~~~';
        blockLines = 0;
      }
    } else if (fence?.startsWith(openFence)) {
      openFence = null;
      longest = Math.max(longest, blockLines);
    } else {
      blockLines += 1;
    }
  }
  // Unterminated fence: everything after the opener is the block.
  if (openFence !== null) longest = Math.max(longest, blockLines);
  return longest;
}

/**
 * Kernel guard on agent-authored memory (note/knowledge/policy). Prompt-side
 * style rules are soft and silently violated; these two are enforced here:
 * - size: text beyond MAX_EMBED_CHARS is stored but never embedded, so it is
 *   semantically unsearchable — a silent lie to future recall.
 * - code dumps: fenced blocks longer than MAX_CODE_BLOCK_LINES belong in the
 *   repo, not in memory.
 * Lifecycle mirrors are exempt — they must store their record verbatim.
 */
function assertAgentMemoryQuality(input: WriteMemoryInput): void {
  if (!AGENT_AUTHORED_SOURCES.has(input.source)) return;
  if (input.textContent.length > MAX_EMBED_CHARS) {
    throw new MemoryWriteValidationError(
      `textContent is ${input.textContent.length} chars but agent-authored memory (${input.source}) is capped at ${MAX_EMBED_CHARS} — the embedding window; anything past it would be stored yet unsearchable. Tighten to facts + pointers, or split into multiple sourceRefs.`,
    );
  }
  const blockLines = longestFencedBlockLines(input.textContent);
  if (blockLines > MAX_CODE_BLOCK_LINES) {
    throw new MemoryWriteValidationError(
      `textContent contains a ${blockLines}-line fenced code block (max ${MAX_CODE_BLOCK_LINES}). Memory stores logic, not code — copied code rots on the next commit. Replace the block with a one-sentence invariant + a file:line or SHA pointer; one-line runnable commands (verify, query) are fine.`,
    );
  }
}

export async function runMemoryWrite(input: WriteMemoryInput): Promise<WriteMemoryResult> {
  assertAgentMemoryQuality(input);
  return indexMemory(
    {
      projectId: input.projectId,
      source: input.source,
      sourceRef: input.sourceRef,
      text: input.textContent,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
    { semanticDedup: SEMANTIC_DEDUP_SOURCES.has(input.source) },
  );
}
