import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { knowledgeEntries, type knowledgeKinds } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { logger } from '../logger.js';

const MAX_EMBED_CHARS = 8192;

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

// MAX_RESPONSE_CHARS guards MCP list responses from token overflow (see
// mcp-list-tools-need-body-free-projection knowledge note).
const MAX_RESPONSE_CHARS = 38_000;

export async function upsertKnowledgeEntry(
  input: UpsertKnowledgeInput,
): Promise<UpsertKnowledgeResult> {
  const embedText = `${input.title}\n\n${input.body}`;
  const truncated = embedText.length > MAX_EMBED_CHARS;
  const toEmbed = truncated ? embedText.slice(0, MAX_EMBED_CHARS) : embedText;

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

export async function listKnowledgeEntries(
  input: ListKnowledgeInput,
): Promise<ListKnowledgeResult> {
  const where = [
    eq(knowledgeEntries.projectId, input.projectId),
    isNull(knowledgeEntries.archivedAt),
    ...(input.kind ? [eq(knowledgeEntries.kind, input.kind)] : []),
    ...(input.injection ? [eq(knowledgeEntries.injection, input.injection)] : []),
  ];

  const rows = await db
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
    })
    .from(knowledgeEntries)
    .where(and(...where))
    .orderBy(asc(knowledgeEntries.orderIndex), asc(knowledgeEntries.slug));

  const total = rows.length;
  const serialized = JSON.stringify({ rows });
  if (serialized.length <= MAX_RESPONSE_CHARS) {
    return { rows, truncated: false, returned: total, total };
  }

  // Trim rows from the tail until we fit under the cap.
  let kept = rows;
  while (kept.length > 1 && JSON.stringify({ rows: kept }).length > MAX_RESPONSE_CHARS) {
    kept = kept.slice(0, kept.length - 1);
  }
  return { rows: kept, truncated: true, returned: kept.length, total };
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
