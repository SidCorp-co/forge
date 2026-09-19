import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type ReleaseAttemptRow,
  type ReleaseAttemptStage,
  releaseAttempts,
} from '../db/schema-release-ledger.js';

export type { ReleaseAttemptRow, ReleaseAttemptStage };

/** Longer than this and the tail is cut, and said to have been cut. */
export const LOG_TAIL_LIMIT = 8_000;

export interface OpenAttemptArgs {
  runId: string;
  stage: ReleaseAttemptStage;
  idempotencyKey: string;
  commit?: string | null;
}

/**
 * Record the INTENT to perform one act. Call before performing it.
 *
 * Re-opening under the same key within one run updates that run's row rather
 * than adding a second: a retry is the same act attempted again, and a ledger
 * that grew a row per retry would make "how many times did this release
 * deploy" unanswerable.
 */
export async function openAttempt(args: OpenAttemptArgs): Promise<ReleaseAttemptRow> {
  const [row] = await db
    .insert(releaseAttempts)
    .values({
      runId: args.runId,
      stage: args.stage,
      idempotencyKey: args.idempotencyKey,
      commit: args.commit ?? null,
    })
    .onConflictDoUpdate({
      target: [releaseAttempts.runId, releaseAttempts.idempotencyKey],
      set: {
        stage: args.stage,
        commit: args.commit ?? null,
        startedAt: sql`now()`,
        settledAt: null,
        health: null,
        identity: null,
        verdict: null,
        verdictReason: null,
        readings: null,
        providerRef: null,
      },
    })
    .returning();
  return row as ReleaseAttemptRow;
}

export interface SettleAttemptArgs {
  runId: string;
  idempotencyKey: string;
  health?: 'up' | 'down' | null;
  identity?: string | null;
  verdict: 'ok' | 'failed';
  verdictReason?: string | null;
  readings?: string[] | null;
}

/**
 * What the act reported back, written onto the row its intent already made.
 */
export async function settleAttempt(args: SettleAttemptArgs): Promise<ReleaseAttemptRow | null> {
  const [row] = await db
    .update(releaseAttempts)
    .set({
      health: args.health ?? null,
      identity: args.identity ?? null,
      verdict: args.verdict,
      verdictReason: args.verdictReason ?? null,
      readings: args.readings ?? null,
      settledAt: sql`now()`,
    })
    .where(
      and(
        eq(releaseAttempts.runId, args.runId),
        eq(releaseAttempts.idempotencyKey, args.idempotencyKey),
      ),
    )
    .returning();
  return (row as ReleaseAttemptRow | undefined) ?? null;
}

export interface RecordAccountArgs {
  runId: string;
  idempotencyKey: string;
  account: string;
  logTail?: string | null;
  /** The provider's own handle on what happened — a deployment uuid, a tag. */
  providerRef?: string | null;
}

/**
 * The agent's own account of an act, and whatever it printed.
 *
 * A tail longer than `LOG_TAIL_LIMIT` is cut BY THE MACHINE, and the row says
 * so and says nobody has read past the cut. A truncation nobody is told about
 * reads as the whole of it, and an operator debugging a failed deploy then
 * believes they have seen the error.
 */
export async function recordAccount(args: RecordAccountArgs): Promise<ReleaseAttemptRow | null> {
  const raw = args.logTail ?? null;
  const truncated = raw !== null && raw.length > LOG_TAIL_LIMIT;
  const [row] = await db
    .update(releaseAttempts)
    .set({
      account: args.account,
      providerRef: args.providerRef ?? null,
      logTail: truncated ? (raw as string).slice(-LOG_TAIL_LIMIT) : raw,
      logTailTruncated: truncated,
      logTailReadAt: null,
      logTailReadBy: null,
    })
    .where(
      and(
        eq(releaseAttempts.runId, args.runId),
        eq(releaseAttempts.idempotencyKey, args.idempotencyKey),
      ),
    )
    .returning();
  return (row as ReleaseAttemptRow | undefined) ?? null;
}

/** Every attempt of one run, oldest first. */
export async function listAttempts(runId: string): Promise<ReleaseAttemptRow[]> {
  return db
    .select()
    .from(releaseAttempts)
    .where(eq(releaseAttempts.runId, runId))
    .orderBy(asc(releaseAttempts.startedAt), asc(releaseAttempts.id));
}

/** One attempt of one run, or `null`. */
export async function readAttempt(
  runId: string,
  idempotencyKey: string,
): Promise<ReleaseAttemptRow | null> {
  const [row] = await db
    .select()
    .from(releaseAttempts)
    .where(
      and(eq(releaseAttempts.runId, runId), eq(releaseAttempts.idempotencyKey, idempotencyKey)),
    )
    .limit(1);
  return (row as ReleaseAttemptRow | undefined) ?? null;
}
