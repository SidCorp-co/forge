// MJ-1: the acts a person takes on a memory from the record it names, or from the project Dashboard
// when it names none (REQ-33 BC-5, BC-7), each correction and retirement with a reason.
//  - Correct: the body is replaced by the person's text. The old body stays readable (the
//    `memories_record_replacement` trigger writes it to memory_revisions), the correction is kept on
//    the row with who and why, and the row counts as verified now: a person just read it against
//    what they know. A release's "possibly stale" flag is cleared with it.
//  - Retire: the row leaves every read surface (archived), and who retired it and why stays on it,
//    so the retired list on the record it names says so. Nothing is deleted here.
//  - Verify ("still true"): the row counts as checked now, by this person. The check is stamped on
//    the row (`last_verified_at`, who on `metadata.verifiedBy`), kept in `metadata.checks`, and the
//    reasons it needed a check fall away: a release's flag is cleared, and a cited record that
//    changes later brings the reason back. One or many rows; each gets its own stamp, and a bulk
//    naming a row it cannot check checks none.
// A mirror of an issue, comment or job is refused: it follows its record, so it is corrected there.
//
// Does NOT check authorization — callers MUST verify writer access to the project first.

import { MEMORY_MIRROR_SOURCES, type MemoryRefusalCode } from '@forge/contracts/memory';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';
import { indexMemory } from './indexer.js';

const refuse = refuser<MemoryRefusalCode>('MEMORY_REFUSED');

const REASON = z.string().trim().min(3).max(1000);

export const memoryCorrectInputSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  reason: REASON,
});

export const memoryVerifyInputSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(200),
});

export const memoryRetireInputSchema = z.object({ reason: REASON });

/** The last acts kept on a row's `metadata.corrections`. */
const CORRECTION_HISTORY_CAP = 20;

/** The `metadata` keys a correction clears: the release flag, which the person has just answered. */
/** The last checks kept on a row's `metadata.checks`. */
const CHECK_HISTORY_CAP = 20;

const FLAG_KEYS = ['staleSince', 'supersededBy'] as const;

async function rowOf(projectId: string, memoryId: string) {
  const [row] = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      text: memories.textContent,
      metadata: memories.metadata,
      archivedAt: memories.archivedAt,
    })
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.projectId, projectId)))
    .limit(1);
  if (!row) {
    throw refuse(
      'MEMORY_NOT_FOUND',
      `no memory ${memoryId} in this project; list them at GET /api/memory/entries`,
      '/memoryId',
    );
  }
  if ((MEMORY_MIRROR_SOURCES as readonly string[]).includes(row.source)) {
    throw refuse(
      'MEMORY_MIRROR_READ_ONLY',
      `memory ${memoryId} is the ${row.source} mirror ${row.sourceRef}: it follows that record, so correct or archive the ${row.source} itself`,
      '/memoryId',
    );
  }
  if (row.archivedAt !== null) {
    throw refuse(
      'MEMORY_ALREADY_RETIRED',
      `memory ${memoryId} was retired at ${row.archivedAt.toISOString()}; a retired memory is read, not changed`,
      '/memoryId',
    );
  }
  return row;
}

export async function correctMemory(args: {
  projectId: string;
  memoryId: string;
  userId: string;
  text: string;
  reason: string;
}): Promise<{ id: string; degraded: boolean }> {
  const row = await rowOf(args.projectId, args.memoryId);
  if (row.text.trim() === args.text.trim()) {
    throw refuse(
      'MEMORY_UNCHANGED',
      'the corrected text is the text already stored; change the text, or retire the memory if it is wrong',
      '/text',
    );
  }
  const md = { ...((row.metadata ?? {}) as Record<string, unknown>) };
  for (const k of FLAG_KEYS) delete md[k];
  const history = Array.isArray(md.corrections) ? md.corrections : [];
  const at = new Date().toISOString();
  md.corrections = [...history, { by: args.userId, at, reason: args.reason }].slice(
    -CORRECTION_HISTORY_CAP,
  );
  md.writtenBy = args.userId;
  md.verifiedBy = args.userId;
  const result = await indexMemory({
    projectId: args.projectId,
    source: row.source,
    sourceRef: row.sourceRef,
    text: args.text,
    metadata: md,
  });
  await db.update(memories).set({ lastVerifiedAt: sql`now()` }).where(eq(memories.id, row.id));
  return { id: result.id, degraded: result.degraded };
}

export async function retireMemory(args: {
  projectId: string;
  memoryId: string;
  userId: string;
  reason: string;
}): Promise<{ id: string; retiredAt: string }> {
  const row = await rowOf(args.projectId, args.memoryId);
  const at = new Date();
  const md = {
    ...((row.metadata ?? {}) as Record<string, unknown>),
    retired: { by: args.userId, at: at.toISOString(), reason: args.reason },
  };
  await db
    .update(memories)
    .set({ archivedAt: at, metadata: md })
    .where(and(eq(memories.id, row.id), sql`${memories.archivedAt} IS NULL`));
  return { id: row.id, retiredAt: at.toISOString() };
}

export async function verifyMemories(args: {
  projectId: string;
  memoryIds: readonly string[];
  userId: string;
}): Promise<{ verified: { id: string; verifiedAt: string }[] }> {
  const ids = [...new Set(args.memoryIds)];
  const rows = [];
  for (const id of ids) rows.push(await rowOf(args.projectId, id));
  const verified: { id: string; verifiedAt: string }[] = [];
  for (const row of rows) {
    const at = new Date();
    const md = { ...((row.metadata ?? {}) as Record<string, unknown>) };
    for (const k of FLAG_KEYS) delete md[k];
    const history = Array.isArray(md.checks) ? md.checks : [];
    md.checks = [...history, { by: args.userId, at: at.toISOString() }].slice(-CHECK_HISTORY_CAP);
    md.verifiedBy = args.userId;
    await db
      .update(memories)
      .set({ lastVerifiedAt: at, metadata: md })
      .where(and(eq(memories.id, row.id), sql`${memories.archivedAt} IS NULL`));
    verified.push({ id: row.id, verifiedAt: at.toISOString() });
  }
  return { verified };
}
