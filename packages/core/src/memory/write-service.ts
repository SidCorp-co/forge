import type { MemoryRefusalCode } from '@forge/contracts/memory';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories, memoryWritableSources } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';
import { type IndexResult, indexMemory, MAX_EMBED_CHARS } from './indexer.js';

/**
 * Shared service for writing a memory row, behind REST `POST /api/memory`.
 *
 * Does NOT check authorization — callers MUST verify project membership
 * before invoking.
 */

export const writeMemoryInputSchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memoryWritableSources),
  sourceRef: z.string().trim().min(1).max(512),
  textContent: z.string().trim().min(1).max(100_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type WriteMemoryInput = z.infer<typeof writeMemoryInputSchema>;

/**
 * Sources where agents author free-form content, so a near-duplicate is worth
 * reporting back to the caller. Lifecycle mirrors (issue/decision/policy)
 * track their source records 1:1 — a near-duplicate there is expected.
 */
const NEAR_DUPLICATE_PROBE_SOURCES = new Set<string>(['note', 'knowledge']);

const refuse = refuser<MemoryRefusalCode>('MEMORY_REFUSED');

const AGENT_AUTHORED_SOURCES = new Set<string>(['note', 'knowledge', 'policy']);

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

function assertAgentMemoryQuality(input: WriteMemoryInput): void {
  if (!AGENT_AUTHORED_SOURCES.has(input.source)) return;
  if (input.textContent.length > MAX_EMBED_CHARS) {
    throw refuse(
      'MEMORY_TEXT_TOO_LONG',
      `textContent is ${input.textContent.length} chars but agent-authored memory (${input.source}) is capped at ${MAX_EMBED_CHARS} — the embedding window; anything past it would be stored yet unsearchable. Tighten to facts + pointers, or split into multiple sourceRefs.`,
      '/textContent',
    );
  }
  const blockLines = longestFencedBlockLines(input.textContent);
  if (blockLines > MAX_CODE_BLOCK_LINES) {
    throw refuse(
      'MEMORY_CODE_BLOCK_TOO_LONG',
      `textContent contains a ${blockLines}-line fenced code block (max ${MAX_CODE_BLOCK_LINES}). Memory stores logic, not code — copied code rots on the next commit. Replace the block with a one-sentence invariant + a file:line or SHA pointer; one-line runnable commands (verify, query) are fine.`,
      '/textContent',
    );
  }
}

/**
 * What a rewrite under an existing ref keeps of the row it replaces: the corrections people made
 * (MJ-1). A row a person retired is refused, not revived — the upsert would otherwise clear the
 * retirement and its reason in silence.
 */
async function carriedFromExisting(input: WriteMemoryInput): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: memories.metadata, archivedAt: memories.archivedAt })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        eq(memories.source, input.source),
        eq(memories.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  if (!row) return {};
  const md = (row.metadata ?? {}) as Record<string, unknown>;
  const retired = md.retired as { at?: unknown; reason?: unknown } | undefined;
  if (row.archivedAt !== null && retired) {
    throw refuse(
      'MEMORY_ALREADY_RETIRED',
      `${input.source} ${input.sourceRef} was retired by a person at ${String(retired.at)} ("${String(retired.reason)}"); write what is true now under a new sourceRef`,
      '/sourceRef',
    );
  }
  return Array.isArray(md.corrections) ? { corrections: md.corrections } : {};
}

/** Who is writing, stamped on the row as `metadata.writtenBy` (MJ-2). */
interface WriteBy {
  writtenBy?: string | undefined;
}

export async function runMemoryWrite(
  input: WriteMemoryInput,
  by: WriteBy = {},
): Promise<IndexResult> {
  assertAgentMemoryQuality(input);
  const carried = await carriedFromExisting(input);
  const metadata = {
    ...(input.metadata ?? {}),
    ...carried,
    ...(by.writtenBy ? { writtenBy: by.writtenBy } : {}),
  };
  return indexMemory(
    {
      projectId: input.projectId,
      source: input.source,
      sourceRef: input.sourceRef,
      text: input.textContent,
      metadata,
    },
    { nearDuplicateProbe: NEAR_DUPLICATE_PROBE_SOURCES.has(input.source) },
  );
}
