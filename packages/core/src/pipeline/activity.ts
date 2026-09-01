import type { Context } from 'hono';
import { type Db, db } from '../db/client.js';
import { type ActorType, activityLog } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { logger } from '../logger.js';

// cm:guard `agency` is REQUIRED so a new writer cannot omit it and silently record the column's default — the default reads as a plausible `human` and nobody reports a feed that looks right. Where a caller genuinely has no agency to give, it must write `'human'` at the call site with a comment saying why, not by leaving the field off here.
export type Actor = { type: ActorType; id: string; agency: ActorAgency };

export interface RecordActivityInput {
  issueId: string;
  actor: Actor;
  action: string;
  before?: unknown;
  after?: unknown;
  payload?: Record<string, unknown>;
  /** ISS-849 — redelivery-dedup key, e.g. `transition:<outboxId>`. */
  dedupeKey?: string;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function buildPayload(input: RecordActivityInput): Record<string, unknown> {
  return {
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    ...(input.payload ?? {}),
  };
}

function buildValues(input: RecordActivityInput) {
  return {
    issueId: input.issueId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorAgency: input.actor.agency,
    action: input.action,
    payload: buildPayload(input),
    dedupeKey: input.dedupeKey ?? null,
  };
}

export async function recordActivity(input: RecordActivityInput): Promise<void> {
  await db.insert(activityLog).values(buildValues(input));
}

export async function recordActivityTx(tx: Tx, input: RecordActivityInput): Promise<void> {
  await tx.insert(activityLog).values(buildValues(input));
}

// Never throws. A failed audit insert must not fail the business operation.
export async function safeRecordActivity(input: RecordActivityInput): Promise<void> {
  try {
    await recordActivity(input);
  } catch (err) {
    logger.error(
      { err, action: input.action, issueId: input.issueId },
      'activity_log insert failed',
    );
  }
}

// cm:guard read `agency` off the context, do NOT infer it from which principal matched — a job token authenticates as a user and is held by an agent, which is the whole reason the field exists. A device principal is an agent by construction and has no context value to read.
export function resolveActor(c: Context): Actor {
  const userId = (c.get('userId' as never) as string | undefined) ?? undefined;
  if (userId) {
    const agency = (c.get('agency' as never) as ActorAgency | undefined) ?? 'human';
    return { type: 'user', id: userId, agency };
  }
  const device = (c.get('device' as never) as { id: string } | undefined) ?? undefined;
  if (device?.id) return { type: 'device', id: device.id, agency: 'agent' };
  throw new Error('resolveActor: no user or device principal on context');
}
