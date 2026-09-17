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
  userPreferences,
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

/** A silence THIS reader set that covers this record. */
// cm:guard the `createdBy` match is what makes a silence a silence rather than a switch.
// Without it one operator saying "stop telling me about this park for an hour" stops
// telling EVERYBODY for an hour — which is the thing ISS-1063 was filed about, wearing a
// deadline. `silences-routes.ts` lists only your own rows, so the screen would show the
// silence to nobody but its author while it muted the whole deployment. Per-reader, and
// evaluated inside the per-recipient loop below, is the whole contract.
async function silencedFor(userId: string, input: DeliverInput, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: notificationSilences.id })
    .from(notificationSilences)
    .where(
      and(
        eq(notificationSilences.createdBy, userId),
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
    // cm:guard both gates below are INSIDE the loop, and every path that delivers comes
    // through here — first delivery, a pending record's promotion, and `deliverExisting`.
    // A gate applied once at the record is a gate that reads one person's preferences and
    // applies the answer to everybody, and a gate applied on the create path only is a
    // gate a promotion walks around.
    if (await silencedFor(userId, input, now)) {
      logger.info(
        { type: input.type, projectId: input.projectId, userId },
        'notifications: silenced for this reader, nobody told',
      );
      continue;
    }
    if (!(await wantsDelivery(userId, input.type))) continue;
    // cm:guard a record reaches one person ONCE. Every periodic detector re-emits the same
    // condition on every tick, so without this the second sweep writes a second delivery
    // and the bell grows a row a minute for a condition nobody's state changed. `told`
    // counts people newly told about THIS record, which is why the check is over the
    // member link and not over the delivery.
    const [already] = await db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveryMembers)
      .innerJoin(
        notificationDeliveries,
        eq(notificationDeliveries.id, notificationDeliveryMembers.deliveryId),
      )
      .where(
        and(
          eq(notificationDeliveryMembers.notificationId, recordId),
          eq(notificationDeliveries.userId, userId),
          eq(notificationDeliveries.resolvedNotice, false),
        ),
      )
      .limit(1);
    if (already) continue;

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
    // cm:guard ISS-1063 — the announcement is per DELIVERY, not per record. Fifteen
    // records joining one grouped delivery used to fire fifteen `notificationCreated`
    // hooks, so the bell collapsed to one row while the toast, the sound and the browser
    // notification still interrupted fifteen times — the 11:21 burst of 2026-09-16
    // surviving in the one channel that interrupts. The record that FOUNDS the delivery
    // announces it; the rest join it quietly and only invalidate the bell.
    let founded = false;
    if (!deliveryId) {
      founded = true;
      const [created] = await db
        .insert(notificationDeliveries)
        .values({
          userId,
          channel: 'bell',
          groupKey: input.groupKey ?? null,
          // A grouped delivery names the cause; an ungrouped one is its record.
          title: input.groupKey ? (input.groupTitle ?? input.title) : input.title,
          createdAt: now,
        })
        .returning({ id: notificationDeliveries.id });
      deliveryId = created?.id;
    }
    if (!deliveryId) continue;
    await db
      .insert(notificationDeliveryMembers)
      .values({ deliveryId, notificationId: recordId })
      .onConflictDoNothing();
    told += 1;

    await hooks.emit('notificationCreated', {
      notificationId: recordId,
      userId,
      announce: founded,
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
 * Whether this reader has opted out of being told about this type.
 *
 * One preference exists today and it is `notifyOnMention`. ISS-1063 moved it here from
 * `notifications/routes.ts#createNotification`, where it gated the whole write: under the
 * split the RECORD is the system's own account of what happened and is not one person's
 * to suppress, so an opt-out now stops the delivery and leaves the record standing.
 */
// cm:guard this is the gate `routes.ts#createNotification` used to hold, and the only
// place it lives now. Deleting it there without landing it here sent mentions to every
// user who had turned them off, which compiles, passes every type check, and is invisible
// until somebody who opted out is @-mentioned.
async function wantsDelivery(userId: string, type: NotificationType): Promise<boolean> {
  if (type !== 'mention') return true;
  const [prefs] = await db
    .select({ notifyOnMention: userPreferences.notifyOnMention })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return prefs ? prefs.notifyOnMention : true;
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

  // cm:guard refuse by name rather than dropping it. A signal is an event: it cannot stop
  // having happened, so a dedup/clear key on one is a caller saying something the model
  // cannot mean. Silently writing NULL would leave the caller believing something clears
  // it, and the row would sit unresolvable for ever — which is the 1771 rows ISS-1063 was
  // filed about. The CHECK constraint refuses the same thing one layer down.
  if (kind === 'signal' && input.resolutionKey) {
    throw new Error(
      `recordAndDeliver: type '${input.type}' is a signal, and a signal may not carry a ` +
        `resolutionKey (got '${input.resolutionKey}'). An event cannot resolve. Either pass ` +
        'no key, or declare the type a condition in notifications/kinds.ts and in ' +
        'packages/contracts/src/notifications.ts.',
    );
  }

  // A condition already carrying this identity is the SAME condition. Stamp that it was
  // seen again, and promote it out of `pending` once it has held long enough.
  const existing = kind === 'condition' ? await activeRecord(input) : null;
  if (existing) {
    const heldFor = existing.pendingSince ? now.getTime() - existing.pendingSince.getTime() : 0;
    const owed = pendingEvaluationsFor(input.type) * EVALUATION_MS;
    const ripe = existing.state === 'pending' && heldFor >= owed;
    // cm:guard inhibition is rechecked AT the promotion, not only at the first sighting. A
    // condition that started pending while the deployment was healthy and matures two
    // minutes into a wedge is a child of that wedge, and promoting it to `firing` on the
    // state of the world two minutes ago reports the cause twice.
    const inhibitedNow = ripe ? await inhibitor(input) : null;
    const promote = ripe && !inhibitedNow;
    await db
      .update(notifications)
      .set({
        lastSeenAt: now,
        ...(promote ? { state: 'firing' as const } : {}),
        ...(ripe && inhibitedNow ? { state: 'inhibited' as const, inhibitedBy: inhibitedNow } : {}),
      })
      .where(eq(notifications.id, existing.id));
    if (existing.state === 'pending' && !promote) return { id: existing.id, delivered: 0 };
    if (existing.state === 'inhibited') return { id: existing.id, delivered: 0 };
    // cm:guard a FIRING record re-emitted tries delivery again, and this is not a second
    // notification: `deliverTo` skips anybody already holding a member link for it. What
    // it catches is the reader who was gated out of the first delivery — silenced, or
    // added to the project since — for whom returning early here meant a condition that
    // is still true and that they were never told about, for as long as it lasted.
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
      resolutionKey: input.resolutionKey ?? null,
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

  const delivered = await deliverTo(record.id, input, now);
  return { id: record.id, delivered };
}
