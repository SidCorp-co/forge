import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { EmbeddingUnavailableError, embedBatch } from '../integrations/llm/index.js';
import { logger } from '../observability/logger.js';
import {
  knowledgeEmbedInput,
  knowledgeEmbedText,
  MAX_EMBED_CHARS,
  type UpsertKnowledgeInput,
  type UpsertKnowledgeResult,
} from './entry-input.js';
import { parseReadWhen, type ReadWhenCondition, readWhenRefusal } from './read-when.js';

export async function upsertKnowledgeEntry(
  input: UpsertKnowledgeInput,
): Promise<UpsertKnowledgeResult> {
  const [row] = await upsertKnowledgeEntries([input]);
  if (!row) throw new Error('knowledge.service: upsert returned no row');
  return row;
}

const entryKey = (input: { projectId: string; slug: string }) =>
  `${input.projectId}\u0000${input.slug}`;

/** The later of two inputs on one key, whole — a multi-row upsert may name a conflict target once. */
function lastPerKey(inputs: UpsertKnowledgeInput[]): UpsertKnowledgeInput[] {
  const byKey = new Map<string, UpsertKnowledgeInput>();
  for (const input of inputs) byKey.set(entryKey(input), input);
  return [...byKey.values()];
}

/**
 * An embeddings OUTAGE degrades the WHOLE batch — `embedBatch` either answers for every text or
 * throws — and each row is then written without a vector for the backfill.
 */
async function embedEntries(
  entries: UpsertKnowledgeInput[],
): Promise<{ vectors: Array<number[] | null>; degraded: boolean }> {
  for (const entry of entries) {
    const length = knowledgeEmbedText(entry.title, entry.body).length;
    if (length <= MAX_EMBED_CHARS) continue;
    logger.warn(
      { projectId: entry.projectId, slug: entry.slug, originalLen: length },
      'knowledge.service: truncated text before embed',
    );
  }
  let embedded: number[][];
  try {
    embedded = await embedBatch(
      { surface: 'knowledge' },
      entries.map((e) => knowledgeEmbedInput(e.title, e.body)),
    );
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    logger.warn(
      { projectId: entries[0]?.projectId, slugs: entries.map((e) => e.slug) },
      'knowledge.service: embeddings unavailable, storing degraded rows for backfill',
    );
    return { vectors: entries.map(() => null), degraded: true };
  }
  if (embedded.length !== entries.length) {
    throw new Error(
      `knowledge.service: embeddings returned ${embedded.length} vectors for ${entries.length} texts`,
    );
  }
  return { vectors: embedded, degraded: false };
}

const baseRow = (input: UpsertKnowledgeInput, embedding: number[] | null) => ({
  projectId: input.projectId,
  slug: input.slug,
  title: input.title,
  body: input.body,
  kind: input.kind,
  injection: input.injection,
  confidence: input.confidence,
  authoredBy: input.authoredBy,
  orderIndex: input.orderIndex,
  embedding,
  metadata: input.metadata ?? {},
});

/** A degraded write keeps the stored vector where neither title nor body moved. */
const baseSet = (degraded: boolean) => ({
  title: sql`excluded.title`,
  body: sql`excluded.body`,
  kind: sql`excluded.kind`,
  injection: sql`excluded.injection`,
  confidence: sql`excluded.confidence`,
  authoredBy: sql`excluded.authored_by`,
  orderIndex: sql`excluded.order_index`,
  embedding: degraded
    ? sql`CASE WHEN ${knowledgeEntries.body} = excluded.body AND ${knowledgeEntries.title} = excluded.title THEN ${knowledgeEntries.embedding} ELSE excluded.embedding END`
    : sql`excluded.embedding`,
  metadata: sql`excluded.metadata`,
  archivedAt: sql`null`,
  updatedAt: sql`now()`,
});

/**
 * `readWhen` is a leave-alone-by-default column: an entry whose write names no `readWhen` at
 * all must not erase a condition a person set on an earlier write, so "the key was absent" and
 * "the key was sent as `null`" are told apart HERE, before either reaches SQL — `undefined`
 * never touches the column, `null` clears it, an object replaces it. Because a single
 * `ON CONFLICT ... SET` clause is one shape for the whole statement, the batch is split into the
 * rows that touch the column and the rows that do not, each its own insert (ISS-1313 criteria
 * 19–23, 31–32).
 */
async function writeEntries(
  entries: UpsertKnowledgeInput[],
  { vectors, degraded }: { vectors: Array<number[] | null>; degraded: boolean },
) {
  const untouched: ReturnType<typeof baseRow>[] = [];
  const touched: Array<ReturnType<typeof baseRow> & { readWhen: ReadWhenCondition | null }> = [];
  for (const [i, input] of entries.entries()) {
    const row = baseRow(input, vectors[i] ?? null);
    if (input.readWhen === undefined) {
      untouched.push(row);
      continue;
    }
    const parsed = parseReadWhen(input.readWhen);
    if (!parsed.ok) throw readWhenRefusal(parsed.refusal);
    touched.push({ ...row, readWhen: parsed.value });
  }
  const set = baseSet(degraded);
  const target = [knowledgeEntries.projectId, knowledgeEntries.slug];
  const returning = {
    id: knowledgeEntries.id,
    slug: knowledgeEntries.slug,
    projectId: knowledgeEntries.projectId,
  };
  // Both inserts share one transaction: two separate top-level statements would let the first
  // commit while the second fails (an invalid project id, say), turning one logical upsert into a
  // partial write — a regression from the single multi-row statement this replaced.
  return db.transaction(async (tx) => [
    ...(untouched.length > 0
      ? await tx
          .insert(knowledgeEntries)
          .values(untouched)
          .onConflictDoUpdate({ target, set })
          .returning(returning)
      : []),
    ...(touched.length > 0
      ? await tx
          .insert(knowledgeEntries)
          .values(touched)
          .onConflictDoUpdate({ target, set: { ...set, readWhen: sql`excluded.read_when` } })
          .returning(returning)
      : []),
  ]);
}

/**
 * The one write path for a knowledge entry: one `embedBatch` over every entry's embed text and
 * one multi-row upsert. `upsertKnowledgeEntry` is this called with a single input, so the embed
 * text, the truncation cut and the conflict clause have exactly one writer.
 */
export async function upsertKnowledgeEntries(
  inputs: UpsertKnowledgeInput[],
): Promise<UpsertKnowledgeResult[]> {
  if (inputs.length === 0) return [];
  const entries = lastPerKey(inputs);
  const embedded = await embedEntries(entries);
  const rows = await writeEntries(entries, embedded);
  const idByKey = new Map(rows.map((r) => [entryKey(r), r.id]));
  return inputs.map((input) => {
    const id = idByKey.get(entryKey(input));
    if (!id) throw new Error(`knowledge.service: upsert returned no row for ${input.slug}`);
    const embedText = knowledgeEmbedText(input.title, input.body);
    return {
      id,
      slug: input.slug,
      degraded: embedded.degraded,
      truncated: embedText.length > MAX_EMBED_CHARS,
    };
  });
}
