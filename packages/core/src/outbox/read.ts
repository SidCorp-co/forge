import type {
  DeadOutboxDeliveriesResponse,
  DeadOutboxDelivery,
} from '@forge/contracts/outbox-consumers';
import type { OutboxEventType } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requireCan } from '../permissions/index.js';

type PgTime = Date | string;

interface DeadRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  type: OutboxEventType;
  consumer: string;
  project_id: string | null;
  issue_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: PgTime;
  dead_at: PgTime;
  total: number;
}

const iso = (t: PgTime) => (t instanceof Date ? t : new Date(t)).toISOString();

function viewOf(r: DeadRow): DeadOutboxDelivery {
  return {
    id: r.id,
    eventId: r.event_id,
    type: r.type,
    consumer: r.consumer,
    projectId: r.project_id,
    issueId: r.issue_id,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: iso(r.created_at),
    deadAt: iso(r.dead_at),
  };
}

/** Dead deliveries, newest first; `projectId` null reads every project's and the project-less ones. */
async function readDead(
  projectId: string | null,
  limit: number,
  offset: number,
): Promise<DeadOutboxDeliveriesResponse> {
  const rows = await db.execute<DeadRow>(sql`
    SELECT d.id, d.event_id, e.type, d.consumer, e.project_id, e.issue_id, d.attempts,
           d.last_error, e.created_at, d.dead_at, count(*) OVER ()::int AS total
      FROM outbox_deliveries d
      JOIN pipeline_outbox e ON e.id = d.event_id
     WHERE d.status = 'dead'
       ${projectId === null ? sql`` : sql`AND e.project_id = ${projectId}`}
     ORDER BY d.dead_at DESC
     LIMIT ${limit} OFFSET ${offset}
  `);
  return { deliveries: rows.map(viewOf), total: rows[0]?.total ?? 0 };
}

export async function listDeadDeliveries(input: {
  userId: string | null | undefined;
  projectId: string;
  limit: number;
  offset: number;
}): Promise<DeadOutboxDeliveriesResponse> {
  await requireCan({ userId: input.userId }, 'project.read', input.projectId);
  return readDead(input.projectId, input.limit, input.offset);
}

/** Every dead delivery, for the platform admin door. */
export function listAllDeadDeliveries(limit: number, offset: number) {
  return readDead(null, limit, offset);
}

export interface DeadDeliveryTally {
  count: number;
  oldestDeadAt: PgTime | null;
  sample: DeadOutboxDelivery[];
}

/** How many deliveries are dead, the oldest, and the newest few: what the ops alert reads. */
export async function tallyDeadDeliveries(sampleSize: number): Promise<DeadDeliveryTally> {
  const [head] = await db.execute<{ count: number; oldest: PgTime | null }>(sql`
    SELECT count(*)::int AS count, min(dead_at) AS oldest
      FROM outbox_deliveries WHERE status = 'dead'
  `);
  const count = head?.count ?? 0;
  if (count === 0) return { count: 0, oldestDeadAt: null, sample: [] };
  const { deliveries } = await readDead(null, sampleSize, 0);
  return { count, oldestDeadAt: head?.oldest ?? null, sample: deliveries };
}

/**
 * Claimable deliveries whose attempt is overdue by more than `overdueMs`: the worker is not
 * draining. One held back behind an earlier delivery of its issue is waiting, not overdue.
 */
export async function countOverdueDeliveries(overdueMs: number): Promise<number> {
  const [row] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM outbox_deliveries c
     WHERE c.status = 'pending'
       AND c.next_attempt_at < now() - ${overdueMs}::int * interval '1 millisecond'
       AND (c.leased_until IS NULL OR c.leased_until < now())
       AND (c.issue_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM outbox_deliveries p
              WHERE p.consumer = c.consumer AND p.issue_id = c.issue_id
                AND p.status = 'pending' AND p.seq < c.seq))
  `);
  return row?.count ?? 0;
}
