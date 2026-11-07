// REQ-89 BC-3 (ISS-1121): what memory's own upkeep did — a release's reconcile, a consolidation sweep —
// is history, kept in `memory_upkeep_records` and never as a memory row: no memory list, count or
// recall reads it. A reconcile reads its own record here to run once per issue.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoryUpkeepRecords } from '../db/schema-memory-upkeep.js';
import { logger } from '../lib/logger.js';

interface UpkeepRecord {
  projectId: string;
  kind: 'reconcile' | 'consolidation';
  ref: string;
  text: string;
  metadata: Record<string, unknown>;
}

/**
 * Keep one upkeep record; a second under the same ref leaves the first. A failure is logged, never
 * thrown: the record is written beside work that must not fail on it.
 */
export async function recordUpkeep(record: UpkeepRecord): Promise<void> {
  try {
    await db
      .insert(memoryUpkeepRecords)
      .values({
        projectId: record.projectId,
        kind: record.kind,
        ref: record.ref,
        textContent: record.text,
        metadata: record.metadata,
      })
      .onConflictDoNothing({ target: [memoryUpkeepRecords.projectId, memoryUpkeepRecords.ref] });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, projectId: record.projectId, ref: record.ref },
      'memory.upkeep: record write failed',
    );
  }
}

/** Whether the project holds an upkeep record under `ref`. */
export async function upkeepRecorded(projectId: string, ref: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memoryUpkeepRecords.id })
    .from(memoryUpkeepRecords)
    .where(and(eq(memoryUpkeepRecords.projectId, projectId), eq(memoryUpkeepRecords.ref, ref)))
    .limit(1);
  return row !== undefined;
}
