import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEdges } from '../db/schema.js';
import { logger } from '../logger.js';

const BATCH_SIZE = 10_000;
const MAX_ITERS = 1000;

function affectedCount(result: unknown): number {
  // postgres-js returns `count`; node-pg returns `rowCount`. Check those
  // before falling back to array length, because postgres-js wraps
  // non-RETURNING UPDATE/DELETE results in an empty array with `.count`
  // attached as a property — `.length` would underreport as 0.
  const r = result as { count?: unknown; rowCount?: unknown } | null;
  if (typeof r?.count === 'number') return r.count;
  if (typeof r?.rowCount === 'number') return r.rowCount;
  if (Array.isArray(result)) return result.length;
  return 0;
}

interface DeletedIdRow {
  id: string;
}

function extractIds(result: unknown): string[] {
  if (Array.isArray(result)) {
    return (result as DeletedIdRow[]).map((row) => row.id).filter((id): id is string => !!id);
  }
  const r = result as { rows?: unknown } | null;
  if (r && Array.isArray(r.rows)) {
    return (r.rows as DeletedIdRow[]).map((row) => row.id).filter((id): id is string => !!id);
  }
  return [];
}

async function deleteBatchWithEdgeCascade(
  whereSql: ReturnType<typeof sql>,
): Promise<{ deleted: number; cascadedEdges: number }> {
  let totalDeleted = 0;
  let totalEdges = 0;
  for (let i = 0; i < MAX_ITERS; i++) {
    // Each batch is its own transaction so a crash mid-cascade can't leave
    // edges pointing at deleted memory uuids — both the memory delete and
    // its edge cleanup commit together or roll back together.
    const { batch, edges } = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        WITH victims AS (
          SELECT id FROM memories
          WHERE ${whereSql}
          LIMIT ${BATCH_SIZE}
        ),
        del AS (
          DELETE FROM memories WHERE id IN (SELECT id FROM victims)
          RETURNING id
        )
        SELECT id::text AS id FROM del
      `);
      const ids = extractIds(result);
      const rowCount = affectedCount(result);
      // If a driver ever reports rows-affected without RETURNING ids (e.g. a
      // future swap from postgres-js), the edge cascade below would silently
      // skip and leave orphans. Surface it loudly so the divergence is fixed
      // before it ships rather than discovered via dangling edges.
      if (rowCount > 0 && ids.length === 0) {
        logger.warn(
          { rowCount },
          'memory-prune: driver returned rowCount without RETURNING ids — edge cascade skipped',
        );
      }
      const batchLocal = ids.length || rowCount;
      let edgesLocal = 0;
      if (ids.length > 0) {
        // Use Drizzle's inArray so the driver serializes the parameter array
        // correctly. postgres-js cannot bind a JS string[] to a single
        // `text[]`-cast positional parameter via the tagged template.
        const edgeRes = await tx
          .delete(knowledgeEdges)
          .where(inArray(knowledgeEdges.sourceMemoryId, ids));
        edgesLocal = affectedCount(edgeRes);
      }
      return { batch: batchLocal, edges: edgesLocal };
    });
    if (batch === 0) break;
    totalDeleted += batch;
    totalEdges += edges;
    if (batch < BATCH_SIZE) break;
  }
  return { deleted: totalDeleted, cascadedEdges: totalEdges };
}

/**
 * Delete stale memories + cascade their knowledge_edges, then invalidate
 * old open-ended edges. Returns aggregate counts. Uses 10k-row batches to
 * avoid long locks. Mirrors `retention-sweeper.ts` driver-shape handling.
 */
export async function runMemoryPrune(): Promise<{
  prunedMemories: number;
  cascadedEdges: number;
  invalidatedEdges: number;
  durationMs: number;
}> {
  const t0 = Date.now();

  const stale = await deleteBatchWithEdgeCascade(
    sql`retrieval_count = 0 AND created_at < now() - interval '30 days'`,
  );
  const rare = await deleteBatchWithEdgeCascade(
    sql`retrieval_count < 3 AND updated_at < now() - interval '90 days'`,
  );

  // Batch the open-edge invalidation so a backlog can't hold a single
  // long-running write lock the way an unbounded UPDATE would. Mirrors the
  // 10k-row cap of the memory-delete path. `ctid` keys the batch so each
  // pass touches a different physical-row slice and we don't rescan rows
  // already advanced past `valid_until IS NULL`.
  let invalidatedEdges = 0;
  for (let i = 0; i < MAX_ITERS; i++) {
    const result = await db.execute(sql`
      WITH victims AS (
        SELECT ctid FROM knowledge_edges
        WHERE valid_until IS NULL
          AND created_at < now() - interval '60 days'
        LIMIT ${BATCH_SIZE}
      )
      UPDATE knowledge_edges
      SET valid_until = now()
      WHERE ctid IN (SELECT ctid FROM victims)
    `);
    const batch = affectedCount(result);
    if (batch === 0) break;
    invalidatedEdges += batch;
    if (batch < BATCH_SIZE) break;
  }

  return {
    prunedMemories: stale.deleted + rare.deleted,
    cascadedEdges: stale.cascadedEdges + rare.cascadedEdges,
    invalidatedEdges,
    durationMs: Date.now() - t0,
  };
}
