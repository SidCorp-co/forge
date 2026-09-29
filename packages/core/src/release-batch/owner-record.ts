// Who owns a release (`pipeline_runs.metadata.owner`): the run session its project's master opened
// over exactly the roster (ISS-1281), when it was taken, and how the ownership ended.

import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { pipelineRuns } from '../db/schema.js';

export const RELEASE_OWNER_KEY = 'owner';

/** The prompt the master hands its release subagent, built when the batch was cut. */
export const RELEASE_BRIEF_KEY = 'brief';

/** On a run session's own run: the release run it owns. */
export const OWNED_RELEASE_KEY = 'releaseRunId';

const REFUSALS_KEPT = 10;

const refusalSchema = z.object({
  at: z.string(),
  deviceId: z.string(),
  deviceName: z.string().nullable(),
  reason: z.string(),
});

export type OwnerRefusal = z.infer<typeof refusalSchema>;

const ownerSchema = z.object({
  state: z.enum(['awaiting', 'owned', 'lost', 'orphaned']),
  since: z.string(),
  deadlineAt: z.string(),
  takenAt: z.string().nullable(),
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  sessionId: z.string().nullable(),
  runId: z.string().nullable(),
  endedAt: z.string().nullable(),
  why: z.string().nullable(),
  refusals: z.array(refusalSchema),
});

/**
 * `lost`: nobody took it by the deadline, or its owner ended before a finish; the roster went back.
 * `orphaned`: the owner ended after a recorded promotion, so the roster is held for a person.
 */
export type ReleaseOwner = z.infer<typeof ownerSchema>;

export class ReleaseOwnerUnreadableError extends Error {
  readonly code = 'RELEASE_OWNER_UNREADABLE';
  constructor(
    public readonly runId: string,
    detail: string,
  ) {
    super(
      `RELEASE_OWNER_UNREADABLE: release run ${runId} carries an owner record this code cannot read (${detail}). ` +
        'Nothing is decided on a record that cannot be read; a person aborts the batch.',
    );
    this.name = 'ReleaseOwnerUnreadableError';
  }
}

/**
 * The owner record, or `null` on a release run opened before ISS-1281, which its job owned.
 * A record that is present and malformed is refused by name rather than read as absent.
 */
export function readOwner(metadata: unknown, runId: string): ReleaseOwner | null {
  const raw = (metadata as Record<string, unknown> | null)?.[RELEASE_OWNER_KEY];
  if (raw === undefined || raw === null) return null;
  const parsed = ownerSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ReleaseOwnerUnreadableError(
      runId,
      `${first?.path.join('.') || 'owner'}: ${first?.message ?? 'not an owner record'}`,
    );
  }
  return parsed.data;
}

/** The brief stored on the run, or `null` before `createReleaseBatch` has written it. */
export function readBrief(metadata: unknown): string | null {
  const raw = (metadata as Record<string, unknown> | null)?.[RELEASE_BRIEF_KEY];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export function awaitingOwner(now: Date, deadlineMs: number): ReleaseOwner {
  return {
    state: 'awaiting',
    since: now.toISOString(),
    deadlineAt: new Date(now.getTime() + deadlineMs).toISOString(),
    takenAt: null,
    deviceId: null,
    deviceName: null,
    sessionId: null,
    runId: null,
    endedAt: null,
    why: null,
    refusals: [],
  };
}

export function withRefusal(owner: ReleaseOwner, refusal: OwnerRefusal): ReleaseOwner {
  return { ...owner, refusals: [...owner.refusals, refusal].slice(-REFUSALS_KEPT) };
}

/** The run's metadata with its owner record replaced. */
export function metadataWithOwner(owner: ReleaseOwner) {
  return sql`jsonb_set(coalesce(${pipelineRuns.metadata}, '{}'::jsonb), ${`{${RELEASE_OWNER_KEY}}`}::text[], ${JSON.stringify(owner)}::jsonb)`;
}

/** The guard a finish acceptance carries: nobody declared this batch's owner lost. */
export const OWNER_NOT_LOST = sql`(${pipelineRuns.metadata} -> ${RELEASE_OWNER_KEY} ->> 'state') IS DISTINCT FROM 'lost'`;

/** No finish attempt, or only one that failed: nothing the finish worker holds. */
export function noFinishInHand(metadata: SQL) {
  return sql`(${metadata} -> 'finish' IS NULL OR ${metadata} -> 'finish' ->> 'state' = 'failed')`;
}

export const NO_FINISH_IN_HAND = noFinishInHand(sql`${pipelineRuns.metadata}`);
