import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { knowledgeEntries, type knowledgeKinds } from '../db/schema.js';
import { logger } from '../logger.js';

const MAX_EMBED_CHARS = 8192;

/** The text a knowledge entry is embedded from — title, blank line, body. */
export const knowledgeEmbedText = (title: string, body: string): string => `${title}\n\n${body}`;
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
export const bodySchema = z
  .string()
  .min(1)
  .max(100_000)
  .refine((s) => s.trim().length > 0, 'body must contain more than whitespace');

export const upsertKnowledgeInputSchema = z.object({
  projectId: z.uuid(),
  slug: slugSchema,
  title: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => s.trim().length > 0, 'title must contain more than whitespace'),
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

export const MAX_RESPONSE_CHARS = 38_000;

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
 * The one write path for a knowledge entry: one `embedBatch` over every entry's embed text and
 * one multi-row upsert. `upsertKnowledgeEntry` is this called with a single input, so the embed
 * text, the truncation cut and the conflict clause have exactly one writer.
 *
 * An embeddings OUTAGE degrades the WHOLE batch — `embedBatch` either answers for every text or
 * throws — and each row is then written without a vector for the backfill, preserving the stored
 * one where neither title nor body moved.
 */
export async function upsertKnowledgeEntries(
  inputs: UpsertKnowledgeInput[],
): Promise<UpsertKnowledgeResult[]> {
  if (inputs.length === 0) return [];
  const entries = lastPerKey(inputs);

  const embedTexts = entries.map((e) => knowledgeEmbedText(e.title, e.body));
  for (const [i, text] of embedTexts.entries()) {
    const entry = entries[i];
    if (!entry || text.length <= MAX_EMBED_CHARS) continue;
    logger.warn(
      { projectId: entry.projectId, slug: entry.slug, originalLen: text.length },
      'knowledge.service: truncated text before embed',
    );
  }

  let vectors: Array<number[] | null> = entries.map(() => null);
  let degraded = false;
  try {
    const { embedBatch } = await import('../embeddings/index.js');
    const embedded = await embedBatch(entries.map((e) => knowledgeEmbedInput(e.title, e.body)));
    if (embedded.length !== embedTexts.length) {
      throw new Error(
        `knowledge.service: embeddings returned ${embedded.length} vectors for ${embedTexts.length} texts`,
      );
    }
    vectors = embedded;
  } catch (err) {
    const { EmbeddingUnavailableError } = await import('../embeddings/index.js');
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    degraded = true;
    logger.warn(
      { projectId: entries[0]?.projectId, slugs: entries.map((e) => e.slug) },
      'knowledge.service: embeddings unavailable, storing degraded rows for backfill',
    );
  }

  const rows = await db
    .insert(knowledgeEntries)
    .values(
      entries.map((input, i) => ({
        projectId: input.projectId,
        slug: input.slug,
        title: input.title,
        body: input.body,
        kind: input.kind,
        injection: input.injection,
        confidence: input.confidence,
        authoredBy: input.authoredBy,
        orderIndex: input.orderIndex,
        embedding: vectors[i] ?? null,
        metadata: input.metadata ?? {},
      })),
    )
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
        embedding: degraded
          ? sql`CASE WHEN ${knowledgeEntries.body} = excluded.body AND ${knowledgeEntries.title} = excluded.title THEN ${knowledgeEntries.embedding} ELSE excluded.embedding END`
          : sql`excluded.embedding`,
        metadata: sql`excluded.metadata`,
        archivedAt: sql`null`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      projectId: knowledgeEntries.projectId,
    });

  const idByKey = new Map(rows.map((r) => [entryKey(r), r.id]));
  return inputs.map((input) => {
    const id = idByKey.get(entryKey(input));
    if (!id) throw new Error(`knowledge.service: upsert returned no row for ${input.slug}`);
    const embedText = knowledgeEmbedText(input.title, input.body);
    return { id, slug: input.slug, degraded, truncated: embedText.length > MAX_EMBED_CHARS };
  });
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

/**
 * Every non-archived entry as slug → body, for a caller that needs the prose
 * itself rather than an index. Each body is cut at `SNAPSHOT_BODY_MAX_CHARS`,
 * which is the cap the `agentConfig.projectFacts` values this replaced were held
 * to; a knowledge body may be 100k, and a snapshot carrying a dozen of those is
 * a payload nobody reads rather than a richer one.
 */
export const SNAPSHOT_BODY_MAX_CHARS = 8000;

export async function selectKnowledgeBodies(projectId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ slug: knowledgeEntries.slug, body: knowledgeEntries.body })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), isNull(knowledgeEntries.archivedAt)))
    .orderBy(asc(knowledgeEntries.slug));
  return Object.fromEntries(rows.map((r) => [r.slug, r.body.slice(0, SNAPSHOT_BODY_MAX_CHARS)]));
}

/** Every non-archived slug this project holds whose body is more than whitespace, whatever its
 *  injection setting — what `missingProjectKnowledge` measures the contract against. */
export async function selectAllSlugsFromKnowledge(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: knowledgeEntries.slug })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        isNull(knowledgeEntries.archivedAt),
        sql`${knowledgeEntries.body} ~ '[^[:space:]]'`,
      ),
    )
    .orderBy(asc(knowledgeEntries.slug));
  return rows.map((r) => r.slug);
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
