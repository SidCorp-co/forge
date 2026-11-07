import { and, eq, sql } from 'drizzle-orm';
import { bodyText } from '../body/prepare.js';
import { db } from '../db/client.js';
import { type MemorySource, memories } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { type IssueHead, memoryIssueReads } from './ports.js';
import { searchMemories } from './search.js';
import { NEAR_DUPLICATE_THRESHOLD } from './thresholds.js';

type Executor = Pick<typeof db, 'insert'>;

/** The parent row as it LANDED — what the race check is read off. */
interface LandedRow {
  id: string;
  embeddedAt: Date;
  textContent: string;
  metadata: unknown;
  hasEmbedding: boolean;
}

function upsertParent(
  exec: Executor,
  input: IndexInput,
  vector: number[] | null,
  preserveUnchangedVector: boolean,
) {
  return exec
    .insert(memories)
    .values({
      projectId: input.projectId,
      source: input.source,
      sourceRef: input.sourceRef,
      textContent: input.text,
      embedding: vector,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [memories.projectId, memories.source, memories.sourceRef],
      set: {
        textContent: sql`excluded.text_content`,
        embedding: preserveUnchangedVector
          ? sql`CASE WHEN ${memories.textContent} = excluded.text_content THEN ${memories.embedding} ELSE excluded.embedding END`
          : sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        // A fresh write revives a decayed/consolidated-away row.
        archivedAt: sql`null`,
        // embeddedAt only advances when a vector was actually written.
        ...(vector === null ? {} : { embeddedAt: sql`now()` }),
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: memories.id,
      embeddedAt: memories.embeddedAt,
      textContent: memories.textContent,
      metadata: memories.metadata,
      hasEmbedding: sql<boolean>`${memories.embedding} is not null`,
    });
}

function describe(head: Pick<IssueHead, 'description' | 'descriptionFormat'>): string {
  return head.description ? bodyText(head.description, head.descriptionFormat) : '';
}

export const MAX_EMBED_CHARS = 8192;

interface IndexInput {
  projectId: string;
  source: MemorySource;
  sourceRef: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** The text's vector, where the caller already embedded it to find the entry it lands on; null for an outage. */
  vector?: number[] | null;
}

export interface IndexResult {
  id: string;
  embeddedAt: Date;
  /**
   * True when text exceeded MAX_EMBED_CHARS and was cut before embedding.
   * The stored `textContent` is always the full text — only the string sent
   * to the embedding model is trimmed.
   */
  truncated: boolean;
  degraded: boolean;
}

/** The stored row's own text and whether it holds a vector — the only two facts the skip reads. */
async function readExisting(
  input: IndexInput,
): Promise<{ textContent: string; hasEmbedding: boolean } | null> {
  const [row] = await db
    .select({
      textContent: memories.textContent,
      hasEmbedding: sql<boolean>`${memories.embedding} is not null`,
    })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        eq(memories.source, input.source),
        eq(memories.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  return row ?? null;
}

interface WriteOutcome {
  row: LandedRow;
  degraded: boolean;
  /** The skip was taken and the swap refused it: the text moved under the pre-read. */
  raceLost: boolean;
}

/** The text's vector for an index write, or null in an embeddings outage (the row is then degraded). */
export async function embedForIndex(input: {
  projectId: string;
  source: string;
  sourceRef: string;
  text: string;
}): Promise<number[] | null> {
  const embedText =
    input.text.length > MAX_EMBED_CHARS ? input.text.slice(0, MAX_EMBED_CHARS) : input.text;
  try {
    return await embed({ surface: 'memory' }, embedText);
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    logger.warn(
      { projectId: input.projectId, source: input.source, sourceRef: input.sourceRef },
      'memory.indexer: embeddings unavailable, storing degraded row for backfill',
    );
    return null;
  }
}

async function writeOnce(input: IndexInput, allowSkip: boolean): Promise<WriteOutcome> {
  const existing = allowSkip ? await readExisting(input) : null;
  const skip = existing !== null && existing.textContent === input.text && existing.hasEmbedding;

  let vector: number[] | null = null;
  let outage = false;
  if (!skip) {
    vector = input.vector !== undefined ? input.vector : await embedForIndex(input);
    outage = vector === null;
  }

  const preserve = skip || outage;
  const [row] = await upsertParent(db, input, vector, preserve);

  if (!row) {
    // Shouldn't happen — UPSERT with returning always returns a row.
    throw new Error('memory.indexer: upsert returned no row');
  }

  const raceLost = skip && !row.hasEmbedding;
  if (raceLost) {
    logger.warn(
      { projectId: input.projectId, source: input.source, sourceRef: input.sourceRef },
      'memory.indexer: the text moved under the skip, re-embedding the text that landed',
    );
  }
  return { row, degraded: outage || raceLost, raceLost };
}

export async function indexMemory(input: IndexInput): Promise<IndexResult> {
  const truncated = input.text.length > MAX_EMBED_CHARS;
  if (truncated) {
    logger.warn(
      {
        projectId: input.projectId,
        source: input.source,
        sourceRef: input.sourceRef,
        originalLen: input.text.length,
      },
      'memory.indexer: truncated text before embed',
    );
  }

  const first = await writeOnce(input, true);
  // the race re-embeds the text that landed: the caller's vector was of the text it lost to
  const { vector: _lost, ...unembedded } = input;
  const outcome = first.raceLost ? await writeOnce(unembedded, false) : first;

  return {
    id: outcome.row.id,
    embeddedAt: outcome.row.embeddedAt,
    truncated,
    degraded: outcome.degraded,
  };
}

/**
 * The live entry of the same source already holding this subject (REQ-89 BC-2): the closest row
 * above NEAR_DUPLICATE_THRESHOLD, other than the ref being written. A write on a held subject lands
 * on that entry rather than beside it.
 */
export async function heldSubject(
  input: { projectId: string; source: MemorySource; sourceRef: string },
  vector: number[],
): Promise<{ id: string; sourceRef: string; score: number } | null> {
  const similar = await searchMemories({
    projectId: input.projectId,
    queryVec: vector,
    topK: 2,
    sourceFilter: [input.source],
  });
  const best = similar.find((h) => h.sourceRef !== input.sourceRef);
  if (!best || best.score <= NEAR_DUPLICATE_THRESHOLD) return null;
  return { id: best.id, sourceRef: best.sourceRef, score: best.score };
}

/**
 * Delete a memory row by its natural key. Returns the number of rows removed
 * (0 or 1 because of the unique constraint on `(projectId, source, sourceRef)`).
 * Idempotent — never throws on missing row.
 */
export async function deleteMemory(
  projectId: string,
  source: MemorySource,
  sourceRef: string,
): Promise<number> {
  const result = await db
    .delete(memories)
    .where(
      and(
        eq(memories.projectId, projectId),
        eq(memories.source, source),
        eq(memories.sourceRef, sourceRef),
      ),
    )
    .returning({ id: memories.id });
  return result.length;
}

/**
 * The memory index's consumers. Each awaits its write, so a failure throws and the outbox retries
 * the event; an embeddings outage never throws here, `indexMemory` stores it as a degraded row.
 */
export function registerMemoryIndexer(): void {
  consume('issue.created', {
    name: 'memory-indexer',
    handle: (p) =>
      indexIssue(p.projectId, p.issueId, {
        ...p.snapshot,
        descriptionFormat: p.snapshot.descriptionFormat ?? null,
      }),
  });

  consume('issue.updated', {
    name: 'memory-indexer',
    handle: async (p) => {
      if (!p.fields.includes('title') && !p.fields.includes('description')) return;
      // `after` holds only the changed fields, so the text is rebuilt from the whole row.
      const head = await memoryIssueReads().head(p.issueId);
      if (head) await indexIssue(p.projectId, p.issueId, head);
    },
  });
}

async function indexIssue(projectId: string, issueId: string, head: IssueHead): Promise<void> {
  const text = [head.title, describe(head)].filter(Boolean).join('\n\n');
  if (!text) return;
  await indexMemory({
    projectId,
    source: 'issue',
    sourceRef: issueId,
    text,
    metadata: { priority: head.priority, category: head.category ?? undefined },
  });
}
