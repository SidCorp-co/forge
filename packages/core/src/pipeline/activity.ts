import type { Context } from 'hono';
import { type Db, db } from '../db/client.js';
import { type ActorType, activityLog } from '../db/schema.js';
import { logger } from '../logger.js';

export type Actor = { type: ActorType; id: string };

export interface RecordActivityInput {
  issueId: string;
  actor: Actor;
  action: string;
  before?: unknown;
  after?: unknown;
  payload?: Record<string, unknown>;
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
    action: input.action,
    payload: buildPayload(input),
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

export function resolveActor(c: Context): Actor {
  const userId = (c.get('userId' as never) as string | undefined) ?? undefined;
  if (userId) return { type: 'user', id: userId };
  const device = (c.get('device' as never) as { id: string } | undefined) ?? undefined;
  if (device?.id) return { type: 'device', id: device.id };
  throw new Error('resolveActor: no user or device principal on context');
}
