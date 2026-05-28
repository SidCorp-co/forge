import { type SQL, and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories, memorySources } from '../db/schema.js';

/**
 * Direct (non-semantic) memory query. Used by REST `GET /api/memory` and
 * MCP `forge_memory.get`. Filters on natural keys + JSONB `@>` containment.
 *
 * Does NOT check authorization — callers MUST verify project membership
 * before invoking.
 */

export const getMemoryInputSchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memorySources).optional(),
  /** Exact match on natural-key sourceRef. Useful for "fetch this handoff". */
  sourceRef: z.string().trim().min(1).max(512).optional(),
  /**
   * JSONB containment filter: every key/value pair must exist in the row's
   * `metadata`. Supports strings, numbers, booleans. Example for handoff
   * lookup: `{ run_id: "<uuid>", step: "plan", attempt: 1 }`.
   */
  metadataFilter: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  orderBy: z.enum(['createdAt', 'updatedAt', 'embeddedAt']).default('createdAt'),
  orderDir: z.enum(['asc', 'desc']).default('desc'),
});

export type GetMemoryInput = z.infer<typeof getMemoryInputSchema>;

export interface MemoryRow {
  id: string;
  projectId: string;
  source: string;
  sourceRef: string;
  textContent: string;
  metadata: unknown;
  embeddedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GetMemoryResult {
  rows: MemoryRow[];
  total: number;
}

export async function runMemoryGet(input: GetMemoryInput): Promise<GetMemoryResult> {
  const conditions: SQL[] = [eq(memories.projectId, input.projectId)];
  if (input.source) conditions.push(eq(memories.source, input.source));
  if (input.sourceRef) conditions.push(eq(memories.sourceRef, input.sourceRef));
  if (input.metadataFilter && Object.keys(input.metadataFilter).length > 0) {
    conditions.push(
      sql`${memories.metadata} @> ${JSON.stringify(input.metadataFilter)}::jsonb`,
    );
  }
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const orderColumn =
    input.orderBy === 'updatedAt'
      ? memories.updatedAt
      : input.orderBy === 'embeddedAt'
        ? memories.embeddedAt
        : memories.createdAt;
  const orderFn = input.orderDir === 'asc' ? asc : desc;

  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memories)
    .where(where);

  const rows = await db
    .select({
      id: memories.id,
      projectId: memories.projectId,
      source: memories.source,
      sourceRef: memories.sourceRef,
      textContent: memories.textContent,
      metadata: memories.metadata,
      embeddedAt: memories.embeddedAt,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(where)
    .orderBy(orderFn(orderColumn))
    .limit(input.limit)
    .offset(input.offset);

  return { rows, total: Number(n) };
}
