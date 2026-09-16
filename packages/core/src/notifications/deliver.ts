/**
 * ISS-1063 — the delivery layer: who gets told about a record, and whether anybody does.
 *
 * A record is what the system says is true. A delivery is one person's copy of it on one
 * channel, and it is the only place a read state lives. Four things stand between a
 * record being written and a person being told, and each is a primitive borrowed whole
 * from an alerting system that already settled it:
 *
 * - **dedup** (PagerDuty's `dedup_key`) — a condition already firing under the same
 *   `resolution_key` is the SAME condition, not a new one. Forge already had the key; it
 *   used it inconsistently.
 * - **pending / for** (Prometheus) — a condition raised by a periodic detector waits for
 *   a second evaluation before anybody hears about it, so a park that clears within two
 *   sweeps never reaches a human.
 * - **inhibition** (Alertmanager) — a firing root cause suppresses its children. The
 *   11:21 burst on 2026-09-16 is the case: 15 conditions, 88 rows, one cause.
 * - **silence** (Alertmanager) — an operator already working on something stops being
 *   told, until a deadline they stated.
 *
 * And one thing stands between a delivery and a second delivery: **grouping**
 * (Alertmanager's `group_by`). Records sharing a `groupKey` reach one recipient as one
 * delivery carrying all of them.
 */

import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { NotificationType } from '../db/schema.js';
import {
  notificationDeliveries,
  notificationDeliveryMembers,
  notificationSilences,
  notifications,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { emissionAllowed, noteSuppressed } from './emission-switch.js';
import { INITIAL_STATE, inhibitorsOf, kindOf, pendingEvaluationsFor, tierOf } from './kinds.js';

/**
 * How long one evaluation of a periodic detector is.
 *
 * Every condition emitter that declares a pending duration is a pass inside
 * `pipeline/sweeper.ts`, which ticks every 60 seconds. A type declaring
 * `pendingEvaluations: 2` therefore waits two minutes for a second sighting.
 */
// cm:edge lockstep -> packages/core/src/pipeline/sweeper.ts — this is that loop's tick; change the sweep interval and every `for` duration in the taxonomy silently changes with it
export const EVALUATION_MS = 60_000;

/** A pending record unseen for this long cleared before it earned a delivery. */
export const PENDING_STALE_MS = 3 * EVALUATION_MS;

export interface DeliverInput {
  type: NotificationType;
  /** Everybody who should be told. One record, one delivery each. */
  recipients: string[];
  title: string;
  body?: string | null;
  projectId?: string | null;
  issueId?: string | null;
  secondaryIssueId?: string | null;
  agentSessionId?: string | null;
  severity?: string | null;
  /** The condition's identity. Two emissions sharing it are one condition. */
  resolutionKey?: string | null;
  dedupeKey?: string | null;
  decisionId?: string | null;
  /** Records raised by one evaluation share this and reach a reader as one delivery. */
  groupKey?: string | null;
  /** What that one delivery is called. Ignored when `groupKey` is absent. */
  groupTitle?: string | null;
}

/** A silence the reader set that covers this record. */
async function silenced(input: DeliverInput, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: notificationSilences.id })
    .from(notificationSilences)
    .where(
      and(
        gt(notificationSilences.expiresAt, now),
        sql`(${notificationSilences.type} IS NULL OR ${notificationSilences.type} = ${input.type})`,
        sql`(${notificationSilences.projectId} IS NULL OR ${notificationSilences.projectId} = ${input.projectId ?? null})`,
        sql`(${notificationSilences.resolutionKey} IS NULL OR ${notificationSilences.resolutionKey} = ${input.resolutionKey ?? null})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The firing record that suppresses this one, if any.
 *
 * Scope is the project: a wedge naming a project's pipeline is the cause of that
 * project's stranded parks, and reporting both is reporting one thing twice.
 */
async function inhibitor(input: DeliverInput): Promise<string | null> {
  const sources = inhibitorsOf(input.type);
  if (sources.length === 0 || !input.projectId) return null;
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        inArray(notifications.type, sources),
        eq(notifications.projectId, input.projectId),
        eq(notifications.state, 'firing'),
        isNull(notifications.resolvedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** The record already carrying this condition's identity, if it is still active. */
async function activeRecord(input: DeliverInput) {
  if (!input.resolutionKey) return null;
  const [row] = await db
    .select({
      id: notifications.id,
      state: notifications.state,
      pendingSince: notifications.pendingSince,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, input.type),
        eq(notifications.resolutionKey, input.resolutionKey),
        isNull(notifications.resolvedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Write one delivery per recipient, joining this record to the group's delivery where the
 * emitter named one. Returns how many people were told for the first time.
 */
async function deliverTo(recordId: string, input: DeliverInput, now: Date): Promise<number> {
  let told = 0;
  for (const userId of input.recipients) {
    let deliveryId: string | undefined;
    if (input.groupKey) {
      const [existing] = await db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.userId, userId),
            eq(notificationDeliveries.groupKey, input.groupKey),
            eq(notificationDeliveries.resolvedNotice, false),
          ),
        )
        .limit(1);
      deliveryId = existing?.id;
    }
    if (!deliveryId) {
      const [created] = await db
        .insert(notificationDeliveries)
        .values({
          userId,
          channel: 'bell',
          groupKey: input.groupKey ?? null,
          createdAt: now,
        })
        .returning({ id: notificationDeliveries.id });
      deliveryId = created?.id;
      if (deliveryId) told += 1;
    }
    if (!deliveryId) continue;
    await db
      .insert(notificationDeliveryMembers)
      .values({ deliveryId, notificationId: recordId })
      .onConflictDoNothing();

    await hooks.emit('notificationCreated', {
      notificationId: recordId,
      userId,
      projectId: input.projectId ?? null,
      type: input.type,
      title: input.groupKey ? (input.groupTitle ?? input.title) : input.title,
      body: input.body ?? null,
      severity: input.severity ?? null,
      resolutionKey: input.resolutionKey ?? null,
      issueId: input.issueId ?? null,
      secondaryIssueId: input.secondaryIssueId ?? null,
      agentSessionId: input.agentSessionId ?? null,
      decisionId: input.decisionId ?? null,
    });
  }
  return told;
}

/**
 * Deliver a record that already exists, to a recipient list.
 *
 * The one producer that needs this is `pm/auto-disable.ts`, whose record must land inside
 * the transaction that disables the cadence while the delivery must not: a delivery that
 * fails should not roll back the disable it was announcing. Everything else goes through
 * {@link recordAndDeliver}, which writes both.
 */
export async function deliverExisting(
  recordId: string,
  recipients: string[],
  now: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      severity: notifications.severity,
      projectId: notifications.projectId,
      issueId: notifications.issueId,
      secondaryIssueId: notifications.secondaryIssueId,
      agentSessionId: notifications.agentSessionId,
      resolutionKey: notifications.resolutionKey,
    })
    .from(notifications)
    .where(eq(notifications.id, recordId))
    .limit(1);
  if (!row) return 0;
  return deliverTo(recordId, { ...row, recipients }, now);
}

/**
 * Record the fact, then decide whether anybody is told about it.
 *
 * Returns the record's id, or `null` when the emission switch refused the type outright.
 * A record written but not delivered still returns its id: the system knows, nobody was
 * told, and those are different answers.
 */
export async function recordAndDeliver(
  input: DeliverInput,
  now: Date = new Date(),
): Promise<{ id: string; delivered: number } | null> {
  if (!emissionAllowed(input.type)) {
    noteSuppressed(input.type, input.title);
    return null;
  }

  const kind = kindOf(input.type);

  // A condition already carrying this identity is the SAME condition. Stamp that it was
  // seen again, and promote it out of `pending` once it has held long enough.
  const existing = kind === 'condition' ? await activeRecord(input) : null;
  if (existing) {
    const heldFor = existing.pendingSince ? now.getTime() - existing.pendingSince.getTime() : 0;
    const owed = pendingEvaluationsFor(input.type) * EVALUATION_MS;
    const promote = existing.state === 'pending' && heldFor >= owed;
    await db
      .update(notifications)
      .set({ lastSeenAt: now, ...(promote ? { state: 'firing' } : {}) })
      .where(eq(notifications.id, existing.id));
    if (!promote) return { id: existing.id, delivered: 0 };
    const delivered = await deliverTo(existing.id, input, now);
    return { id: existing.id, delivered };
  }

  const inhibitedBy = kind === 'condition' ? await inhibitor(input) : null;
  const waits = kind === 'condition' && pendingEvaluationsFor(input.type) > 0;
  const state = inhibitedBy ? 'inhibited' : waits ? 'pending' : INITIAL_STATE[kind];

  const [record] = await db
    .insert(notifications)
    .values({
      projectId: input.projectId ?? null,
      type: input.type,
      kind,
      tier: tierOf(input.type),
      state,
      title: input.title,
      body: input.body ?? null,
      severity: input.severity ?? null,
      // cm:guard a signal carries neither, and a CHECK constraint refuses the row if it does — an event cannot stop having happened, so a resolution key on one is the defect ISS-1063 was filed about
      resolutionKey: kind === 'signal' ? null : (input.resolutionKey ?? null),
      dedupeKey: input.dedupeKey ?? null,
      issueId: input.issueId ?? null,
      secondaryIssueId: input.secondaryIssueId ?? null,
      agentSessionId: input.agentSessionId ?? null,
      groupKey: input.groupKey ?? null,
      inhibitedBy,
      pendingSince: kind === 'condition' ? now : null,
      lastSeenAt: kind === 'condition' ? now : null,
      createdAt: now,
    })
    .returning({ id: notifications.id });
  if (!record) throw new Error('notifications: insert returned no row');

  if (inhibitedBy) {
    logger.info(
      { type: input.type, projectId: input.projectId, inhibitedBy },
      'notifications: inhibited by a firing root cause, nobody told',
    );
    return { id: record.id, delivered: 0 };
  }
  if (state === 'pending') return { id: record.id, delivered: 0 };
  if (await silenced(input, now)) {
    logger.info({ type: input.type, projectId: input.projectId }, 'notifications: silenced');
    return { id: record.id, delivered: 0 };
  }

  const delivered = await deliverTo(record.id, input, now);
  return { id: record.id, delivered };
}
