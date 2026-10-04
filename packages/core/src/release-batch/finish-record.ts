// The finish record a release run carries (`pipeline_runs.metadata.finish`): its
// shape, how it is read off the run, and the compare-and-set that writes it.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/index.js';
import { logger } from '../observability/logger.js';
import { RUN_NOT_ABORTED } from './abort-stamp.js';
import type { ReleaseVerification } from './plan.js';
import { releaseBatchPorts } from './ports.js';

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
  /** How the close was proved (ISS-1321); a resume re-reads an `unverified` one. `null` before
   *  that is known, and on older records, whose `closing` was only ever reached by a green probe. */
  verification: ReleaseVerification | null;
  finishedAt: string | null;
}

const VERIFICATIONS: ReadonlySet<string> = new Set<ReleaseVerification>(['probed', 'unverified']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function actorOf(v: unknown): TransitionActor | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  const id = str(a.id);
  if (!id) return null;
  if (a.type === 'user') {
    return a.agency === 'human' || a.agency === 'agent'
      ? { type: 'user', id, agency: a.agency }
      : null;
  }
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
    verification: VERIFICATIONS.has(str(r.verification) ?? '')
      ? (r.verification as ReleaseVerification)
      : null,
    finishedAt: str(r.finishedAt),
  };
}

export function isInFlight(record: ReleaseFinishRecord | null): boolean {
  return record !== null && IN_FLIGHT.has(record.state);
}

/**
 * Write `next` over the record whose version was `expected` (`null` = the run
 * carries no record). `false` when somebody else wrote in between, or, with
 * `runOpen`, when the run was aborted in between: cancelled, or stamped by an abort under way.
 */
export async function compareAndSet(
  runId: string,
  expected: number | null,
  next: ReleaseFinishRecord,
  { runOpen = false }: { runOpen?: boolean } = {},
): Promise<boolean> {
  const version =
    expected === null
      ? sql`${pipelineRuns.metadata} -> 'finish' IS NULL`
      : sql`(${pipelineRuns.metadata} -> 'finish' ->> 'version')::int = ${expected}`;
  const guard = runOpen ? and(version, RUN_NOT_ABORTED) : version;
  return releaseBatchPorts().writeRunMetadata(runId, {
    merge: { finish: next },
    when: guard,
    touch: false,
  });
}

export function stamp(
  prev: ReleaseFinishRecord,
  patch: Partial<ReleaseFinishRecord>,
): ReleaseFinishRecord {
  return { ...prev, ...patch, version: prev.version + 1, updatedAt: new Date().toISOString() };
}
