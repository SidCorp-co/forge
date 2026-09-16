/**
 * Writing and reading one attempt of a release.
 *
 * TWO STAGES, and the order is the whole design: the intent goes down BEFORE
 * the act it describes, and the readings and the verdict update that same row
 * afterwards. A ledger written after the fact records only what finished, so a
 * release killed mid-deploy leaves nothing at all — which is precisely the
 * release worth reading about.
 *
 * The agent's account and core's verdict are stored beside each other and
 * neither is derived from the other. `settleAttempt` is the only writer of the
 * machine half and it is never reached from a route body; `recordAccount` is
 * the only writer of the agent's half and it cannot touch the machine's.
 */

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
// cm:guard the conflict target is `(run_id, idempotency_key)` and the key ALONE would be wrong. Two runs retrying `deploy-1` are two acts on two rosters, and folding the second into the first hands a release another release's readings.
// cm:guard re-opening CLEARS the machine half. A second attempt under one key is a fresh act, and leaving the previous verdict on the row would have the bounds read a settled failure as this attempt's outcome while it is still in flight.
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
// cm:guard core's own call and never a route body's. Everything set here is what CORE read; an agent handed a door onto these columns is the sentence-as-evidence this whole table replaces, which is why `recordAccount` exists next door and writes none of them. `providerRef` is deliberately NOT here: a Coolify deployment uuid is a fact only the caller holds, so it travels with the account, where it is read as something reported rather than as something measured.
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
// cm:guard `logTailReadAt` stays NULL here and is not defaulted to now(): the cut is the machine's and reading it is a person's, so a write that stamped both would make every cut look attended the moment it happened.
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
