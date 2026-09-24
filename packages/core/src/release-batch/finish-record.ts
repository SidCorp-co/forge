// The finish record a release run carries (`pipeline_runs.metadata.finish`): its
// shape, how it is read off the run, and the compare-and-set that writes it.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { logger } from '../logger.js';

export type FinishState = 'accepted' | 'verifying' | 'closing' | 'finished' | 'failed';

export const IN_FLIGHT: ReadonlySet<FinishState> = new Set(['accepted', 'verifying', 'closing']);
const STATES: ReadonlySet<string> = new Set([...IN_FLIGHT, 'finished', 'failed']);

/** Why an attempt ended red, in the vocabulary the door answers with. */
export interface FinishRefusal {
  code: string;
  reason: string;
  live: string | null;
}

export interface ReleaseFinishRecord {
  /** One per accepted attempt. A retry of the same attempt answers the same id. */
  requestId: string;
  state: FinishState;
  /** The whole sha the caller claims was pushed, or `null` to ask only that the deploy arrived. */
  commit: string | null;
  requestedBy: TransitionActor;
  acceptedAt: string;
  updatedAt: string;
  /** Bumped by every write; the compare-and-set token. */
  version: number;
  /** The worker holding this attempt, while one does. */
  owner: string | null;
  leaseUntil: string | null;
  workerStarts: number;
  closed: string[] | null;
  failed: Array<{ id: string; reason: string }> | null;
  refusal: FinishRefusal | null;
  finishedAt: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function actorOf(v: unknown): TransitionActor | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  const id = str(a.id);
  if (!id) return null;
  if (a.type === 'user')
    return { type: 'user', id, ...(a.agency ? { agency: a.agency } : {}) } as TransitionActor;
  const ownerId = str(a.ownerId);
  if (a.type === 'device' && ownerId) return { type: 'device', id, ownerId };
  return null;
}

/**
 * The finish record a run carries, or `null` when it carries none. A record this
 * code cannot read is `null` too, and logged: it is never guessed into a state.
 */
export function readFinishRecord(metadata: unknown): ReleaseFinishRecord | null {
  const raw = (metadata as { finish?: unknown } | null)?.finish;
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const requestId = str(r.requestId);
  const state = str(r.state);
  const requestedBy = actorOf(r.requestedBy);
  if (!requestId || !state || !STATES.has(state) || !requestedBy || typeof r.version !== 'number') {
    logger.error({ finish: raw }, 'release-batch: a finish record this code cannot read');
    return null;
  }
  const refusal = r.refusal as Record<string, unknown> | null | undefined;
  return {
    requestId,
    state: state as FinishState,
    commit: str(r.commit),
    requestedBy,
    acceptedAt: str(r.acceptedAt) ?? '',
    updatedAt: str(r.updatedAt) ?? '',
    version: r.version,
    owner: str(r.owner),
    leaseUntil: str(r.leaseUntil),
    workerStarts: typeof r.workerStarts === 'number' ? r.workerStarts : 0,
    closed: Array.isArray(r.closed) ? (r.closed as string[]) : null,
    failed: Array.isArray(r.failed) ? (r.failed as Array<{ id: string; reason: string }>) : null,
    refusal:
      refusal && typeof refusal === 'object'
        ? {
            code: str(refusal.code) ?? 'RELEASE_FINISH_ERRORED',
            reason: str(refusal.reason) ?? '',
            live: str(refusal.live),
          }
        : null,
    finishedAt: str(r.finishedAt),
  };
}

export function isInFlight(record: ReleaseFinishRecord | null): boolean {
  return record !== null && IN_FLIGHT.has(record.state);
}

/**
 * Write `next` over the record whose version was `expected` (`null` = the run
 * carries no record). `false` when somebody else wrote in between.
 */
export async function compareAndSet(
  runId: string,
  expected: number | null,
  next: ReleaseFinishRecord,
): Promise<boolean> {
  const guard =
    expected === null
      ? sql`${pipelineRuns.metadata} -> 'finish' IS NULL`
      : sql`(${pipelineRuns.metadata} -> 'finish' ->> 'version')::int = ${expected}`;
  const rows = await db
    .update(pipelineRuns)
    .set({
      metadata: sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || ${JSON.stringify({ finish: next })}::jsonb`,
    })
    .where(and(eq(pipelineRuns.id, runId), guard))
    .returning({ id: pipelineRuns.id });
  return rows.length > 0;
}

export function stamp(
  prev: ReleaseFinishRecord,
  patch: Partial<ReleaseFinishRecord>,
): ReleaseFinishRecord {
  return { ...prev, ...patch, version: prev.version + 1, updatedAt: new Date().toISOString() };
}
