import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { knowledgeEntries, type knowledgeKinds } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { logger } from '../logger.js';

const MAX_EMBED_CHARS = 8192;

/** The text a knowledge entry is embedded from — title, blank line, body. */
export const knowledgeEmbedText = (title: string, body: string): string => `${title}\n\n${body}`;
// cm:guard the upsert and memory/embedding-backfill.ts embed the SAME string — a degraded upsert stores `embedding = NULL` and logs "for backfill", and the backfill's re-embed must be the vector the upsert would have written, or a backfilled entry ranks differently from a fresh one forever (ISS-907, extra fix)
/** What is actually sent to the embeddings service: the embed text cut at MAX_EMBED_CHARS. */
export const knowledgeEmbedInput = (title: string, body: string): string =>
  knowledgeEmbedText(title, body).slice(0, MAX_EMBED_CHARS);

export const knowledgeKindEnum = [
  'overview',
  'scenario',
  'workflow',
  'rule',
  'guide',
  'reference',
  'glossary',
] as const satisfies readonly (typeof knowledgeKinds)[number][];

export const knowledgeInjectionEnum = ['always', 'on_demand', 'none'] as const;
export const knowledgeConfidenceEnum = ['verified', 'inferred', 'deprecated'] as const;
export const knowledgeAuthoredByEnum = ['human', 'agent', 'imported'] as const;

export const slugSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case');
export const bodySchema = z.string().min(1).max(100_000);

export const upsertKnowledgeInputSchema = z.object({
  projectId: z.uuid(),
  slug: slugSchema,
  title: z.string().min(1).max(500),
  body: bodySchema,
  kind: z.enum(knowledgeKindEnum).default('guide'),
  injection: z.enum(knowledgeInjectionEnum).default('on_demand'),
  confidence: z.enum(knowledgeConfidenceEnum).default('inferred'),
  authoredBy: z.enum(knowledgeAuthoredByEnum).default('agent'),
  orderIndex: z.number().int().default(0),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type UpsertKnowledgeInput = z.infer<typeof upsertKnowledgeInputSchema>;

export interface UpsertKnowledgeResult {
  id: string;
  slug: string;
  degraded: boolean;
  truncated: boolean;
}

// cm:why an MCP list response is spent from the caller's context window, so the cap is a token budget rather than a payload limit — raising it makes every list cost more of the window it is read in.
export const MAX_RESPONSE_CHARS = 38_000;

export async function upsertKnowledgeEntry(
  input: UpsertKnowledgeInput,
): Promise<UpsertKnowledgeResult> {
  const embedText = knowledgeEmbedText(input.title, input.body);
  const truncated = embedText.length > MAX_EMBED_CHARS;
  const toEmbed = truncated ? knowledgeEmbedInput(input.title, input.body) : embedText;

  if (truncated) {
    logger.warn(
      { projectId: input.projectId, slug: input.slug, originalLen: embedText.length },
      'knowledge.service: truncated text before embed',
    );
  }

  let vector: number[] | null = null;
  try {
    vector = await embed(toEmbed);
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    logger.warn(
      { projectId: input.projectId, slug: input.slug },
      'knowledge.service: embeddings unavailable, storing degraded row for backfill',
    );
  }
  const degraded = vector === null;

  const [row] = await db
    .insert(knowledgeEntries)
    .values({
      projectId: input.projectId,
      slug: input.slug,
      title: input.title,
      body: input.body,
      kind: input.kind,
      injection: input.injection,
      confidence: input.confidence,
      authoredBy: input.authoredBy,
      orderIndex: input.orderIndex,
      embedding: vector,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [knowledgeEntries.projectId, knowledgeEntries.slug],
      set: {
        title: sql`excluded.title`,
        body: sql`excluded.body`,
        kind: sql`excluded.kind`,
        injection: sql`excluded.injection`,
        confidence: sql`excluded.confidence`,
        authoredBy: sql`excluded.authored_by`,
        orderIndex: sql`excluded.order_index`,
        // Degraded re-write: preserve existing vector when body unchanged.
        embedding: degraded
          ? sql`CASE WHEN ${knowledgeEntries.body} = excluded.body THEN ${knowledgeEntries.embedding} ELSE excluded.embedding END`
          : sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        archivedAt: sql`null`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: knowledgeEntries.id });

  if (!row) throw new Error('knowledge.service: upsert returned no row');
  return { id: row.id, slug: input.slug, degraded, truncated };
}

export interface ListKnowledgeInput {
  projectId: string;
  kind?: (typeof knowledgeKindEnum)[number] | undefined;
  injection?: (typeof knowledgeInjectionEnum)[number] | undefined;
}

export interface KnowledgeListRow {
  id: string;
  slug: string;
  kind: string;
  title: string;
  injection: string;
  confidence: string;
  authoredBy: string;
  orderIndex: number;
  updatedAt: Date;
}

export interface ListKnowledgeResult {
  rows: KnowledgeListRow[];
  truncated: boolean;
  returned: number;
  total: number;
}

/**
 * The row cap on the LIST query. `MAX_RESPONSE_CHARS` is the real bound; this
 * only stops an unbounded fetch on the way to it, so it must sit ABOVE the
 * largest number of rows that can fit under the character cap — otherwise the
 * database would cut a row the cap would have kept, which is the silent
 * shortening this bound exists to prevent. `service.test.ts` holds it: the
 * shortest row this projection can serialise, taken MAX_LIST_ROWS times, is
 * longer than MAX_RESPONSE_CHARS.
 */
export const MAX_LIST_ROWS = 1000;

/** `{"rows":[]}` — the envelope the cap is measured against. */
const RESPONSE_ENVELOPE_CHARS = 11;

/**
 * Keep the longest prefix of `rows` whose serialisation fits under
 * `MAX_RESPONSE_CHARS`, at least one row — a single row wider than the cap is
 * returned rather than dropped, as it was before. `truncated` is now
 * `returned < total` on every path, so that one row reads as complete instead
 * of truncated; the projection's own field caps (slug 512, title 500) put the
 * widest possible row near 1.2k characters, so nothing reaches it.
 */
// cm:guard the running count and the whole-array `JSON.stringify` it replaced measure the SAME thing — JavaScript string length over the same serialisation, never UTF-8 bytes — because a title outside the BMP would otherwise drop a row from a response that used to carry it. The old loop re-serialised every kept row for each row it dropped; on a project over the cap that is quadratic in the payload (ISS-1025).
function trimToResponseCap(rows: KnowledgeListRow[]): KnowledgeListRow[] {
  let used = RESPONSE_ENVELOPE_CHARS;
  for (let i = 0; i < rows.length; i += 1) {
    // biome-ignore lint/style/noNonNullAssertion: index is below rows.length
    used += JSON.stringify(rows[i]!).length + (i > 0 ? 1 : 0);
    if (used > MAX_RESPONSE_CHARS) return rows.slice(0, Math.max(1, i));
  }
  return rows;
}

export async function listKnowledgeEntries(
  input: ListKnowledgeInput,
): Promise<ListKnowledgeResult> {
  const where = [
    eq(knowledgeEntries.projectId, input.projectId),
    isNull(knowledgeEntries.archivedAt),
    ...(input.kind ? [eq(knowledgeEntries.kind, input.kind)] : []),
    ...(input.injection ? [eq(knowledgeEntries.injection, input.injection)] : []),
  ];

  // cm:guard `count(*) over ()` rather than a second `count(*)` query: a window function is evaluated before LIMIT, so `total` is the number of matching entries in the table while the fetch stays bounded — one query for both, which is what the list contract asks for.
  const fetched = await db
    .select({
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      kind: knowledgeEntries.kind,
      title: knowledgeEntries.title,
      injection: knowledgeEntries.injection,
      confidence: knowledgeEntries.confidence,
      authoredBy: knowledgeEntries.authoredBy,
      orderIndex: knowledgeEntries.orderIndex,
      updatedAt: knowledgeEntries.updatedAt,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(knowledgeEntries)
    .where(and(...where))
    .orderBy(asc(knowledgeEntries.orderIndex), asc(knowledgeEntries.slug))
    .limit(MAX_LIST_ROWS);

  const total = fetched[0]?.total ?? 0;
  const rows: KnowledgeListRow[] = fetched.map(({ total: _total, ...row }) => row);

  const kept = trimToResponseCap(rows);
  return { rows: kept, truncated: kept.length < total, returned: kept.length, total };
}

export interface GetKnowledgeResult {
  id: string;
  slug: string;
  kind: string;
  title: string;
  body: string;
  injection: string;
  confidence: string;
  authoredBy: string;
  orderIndex: number;
  metadata: unknown;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function getKnowledgeEntry(
  projectId: string,
  slug: string,
): Promise<GetKnowledgeResult | null> {
  const [row] = await db
    .select({
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      kind: knowledgeEntries.kind,
      title: knowledgeEntries.title,
      body: knowledgeEntries.body,
      injection: knowledgeEntries.injection,
      confidence: knowledgeEntries.confidence,
      authoredBy: knowledgeEntries.authoredBy,
      orderIndex: knowledgeEntries.orderIndex,
      metadata: knowledgeEntries.metadata,
      archivedAt: knowledgeEntries.archivedAt,
      createdAt: knowledgeEntries.createdAt,
      updatedAt: knowledgeEntries.updatedAt,
    })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), eq(knowledgeEntries.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function deleteKnowledgeEntry(projectId: string, slug: string): Promise<number> {
  const result = await db
    .delete(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), eq(knowledgeEntries.slug, slug)))
    .returning({ id: knowledgeEntries.id });
  return result.length;
}

// ─── Injection-source helpers (used by prompt/facts/resolve.ts when flag ON) ──

export interface AlwaysInjectFact {
  key: string;
  text: string;
}

export async function selectAlwaysInjectFromKnowledge(
  projectId: string,
): Promise<AlwaysInjectFact[]> {
  const rows = await db
    .select({
      slug: knowledgeEntries.slug,
      body: knowledgeEntries.body,
      orderIndex: knowledgeEntries.orderIndex,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.injection, 'always'),
        isNull(knowledgeEntries.archivedAt),
      ),
    )
    .orderBy(asc(knowledgeEntries.orderIndex), asc(knowledgeEntries.slug));
  return rows.map((r) => ({ key: r.slug, text: r.body }));
}

export async function selectOnDemandSlugsFromKnowledge(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: knowledgeEntries.slug, orderIndex: knowledgeEntries.orderIndex })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.injection, 'on_demand'),
        isNull(knowledgeEntries.archivedAt),
      ),
    )
    .orderBy(asc(knowledgeEntries.orderIndex), asc(knowledgeEntries.slug));
  return rows.map((r) => r.slug);
}
