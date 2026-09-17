/**
 * ISS-1063 — the notification schema: the record, and everything between a record and a person.
 *
 * `notifications` is the SYSTEM's record of a fact — no `user_id`, no `read`. The three tables
 * after it are who was told (`notification_deliveries`, where a read state lives and the only
 * place it lives), which records a delivery carries (`notification_delivery_members`, which is
 * what grouping IS), and who asked not to be told for a while (`notification_silences`).
 *
 * They are their own file because `db/schema.ts` is 3,300 lines and its size budget is frozen
 * against a baseline that may only move down — a gate refusing the re-freeze is what asked for
 * this split, and the split is an improvement the file was owed anyway. `schema.ts` re-exports
 * everything here, so every existing `from '../db/schema.js'` import keeps working and
 * drizzle-kit still sees one schema.
 *
 * cm:guard nothing in this file may READ a binding from `schema.ts` at module-evaluation time —
 * `schema.ts` imports this file to re-export it, so the two are a cycle and a top-level read of a
 * half-initialised binding is a TDZ crash at boot. Every reference to `users`, `projects`,
 * and `issues` here is inside a `() =>` or a `relations()` callback, which is why
 * the cycle is safe.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { issues, projects, users } from './schema.js';

// cm:edge lockstep -> packages/contracts/src/notifications.ts — NOTIFICATION_TYPES + NOTIFICATION_CONTRACT carry the same taxonomy; core validates the column against THIS list while every emitter is typed against the contracts one, so a value added here alone is insertable but untyped, and one added there alone typechecks then fails at the column
// cm:why ISS-1063 removed `comment_added` and `agent_completed` from here and from the
// contract in the same change: neither string appeared anywhere in `packages/core/src`
// outside these two declarations, so neither had an emitter to run, and neither had ever
// produced a row in the 11037 on the production replica. `mention` and
// `retry_rescue_threshold` show the same zero and stay, because both have live wired
// emitters whose trigger has not occurred.
export const notificationTypes = [
  'issue_status_changed',
  'mention',
  'pm_escalation',
  // ISS-452 (ISS-442 C6 / I7) — a loop-monitor hop miss / non-progressing
  // pipeline state surfaced to the project owner (see pipeline/wedge.ts).
  'pipeline_wedge',
  // ISS-597 — pending project/org invitation surfaced to the invitee's bell.
  'invitation_received',
  // ISS-606 — intake gate parked a new issue at draft; owner must approve.
  'intake_pending',
  // ISS-618 — a script-kind schedule's ctx.notify() payload delivered to the
  // owner (report/API-check results with no LLM involved).
  'schedule_report',
  'reconcile_gate_pending',
  // cm:why ISS-762 — `waiting` + merged code is the one issue state that contradicts itself, and nothing else surfaces it
  'issue_stranded',
  'retry_rescue_threshold',
  'ops_alert',
] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const notificationKindValues = ['signal', 'condition', 'task'] as const;
export const notificationTierValues = ['page', 'ticket', 'log'] as const;

/**
 * ISS-1063 — the RECORD layer: what the system says is true. One row per fact, whoever
 * is told about it.
 *
 * `user_id` and `read` used to live here, which is what made one row both the record and
 * one person's copy of it, and what forced `read` ("has a human looked") to sit beside
 * `resolved_at` ("is it still true") answering unrelated questions. They now live on
 * `notification_deliveries`, one row per recipient per channel. A condition told to six
 * project admins is ONE row here and six there — 2997 `issue_stranded` rows on the
 * production replica were 545 conditions wearing their recipients' names.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type', { enum: notificationTypes }).notNull(),
    // cm:edge lockstep -> packages/core/src/notifications/kinds.ts — the kind a type declares there must be the kind its rows carry here; `kinds.test.ts` compares both against the contract and fails naming the pair that disagree
    kind: text('kind', { enum: notificationKindValues }).notNull(),
    tier: text('tier', { enum: notificationTierValues }).notNull(),
    // cm:guard the value must belong to its kind's own set (`STATES_BY_KIND`), which a CHECK constraint enforces in the migration: no state name is shared between two kinds, so a state names its kind and a row cannot be half a signal and half a condition
    state: text('state').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    // ISS-510 — per-event severity (from the `@forge/contracts` notification
    // contract) drives toast tone + bell hue. Nullable: legacy rows predate it.
    severity: text('severity'),
    // cm:guard `resolvedAt IS NULL` is what "still happening" means, and every reader must use it — NOT `read = false`, which only says whether a human has looked. resolveNotifications clears by key on that predicate alone (this comment claimed "unread" until main corrected the code); an ops_alert additionally has a partial unique index over the same predicate, so a row left unstamped blocks its own recurrence forever.
    resolutionKey: text('resolution_key'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    // ISS-619 — a second, distinct issue reference for notifications whose
    // actionable target differs from `issueId` (e.g. a dependency-stall wedge:
    // `issueId` stays the wedged issue for interventions-metric attribution,
    // `secondaryIssueId` is the blocker/child the user actually needs to act on).
    secondaryIssueId: uuid('secondary_issue_id').references(() => issues.id, {
      onDelete: 'set null',
    }),
    agentSessionId: uuid('agent_session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // cm:why ISS-1063 — a condition's producer re-derives its predicate every sweep tick and emits again; this is the last tick that still saw it. A `pending` record whose `last_seen_at` goes stale cleared before it earned a delivery, and the re-evaluation sweep drops it rather than telling anybody about something already false.
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    // cm:why ISS-1063 — Prometheus's `for`: when the condition was first seen. A type declaring `pendingEvaluations` is delivered only once this is old enough, which is what stops a park that clears within two sweeps from ever reaching a human.
    pendingSince: timestamp('pending_since', { withTimezone: true }),
    // cm:why ISS-1063 — Alertmanager's grouping: every record a detector raised in ONE evaluation shares this, so fifteen parks found by one sweep reach a reader as one delivery naming the cause instead of fifteen (the 11:21 burst on 2026-09-16, 88 rows over 7 users).
    groupKey: text('group_key'),
    // cm:why ISS-1063 — Alertmanager's inhibition: the firing record that suppressed this one. A record carrying it has no delivery at all; when the root resolves it goes back to `pending` rather than being delivered, so a child that cleared while suppressed announces nothing.
    inhibitedBy: uuid('inhibited_by'),
    // cm:why ISS-849 redelivery guard (`transition:<outboxId>`) — deliberately NOT `resolutionKey`, which answers "is the condition still true"; one key says do-not-send-twice, the other says the incident is over, and collapsing them would resolve an alert the moment it was redelivered
    dedupeKey: text('dedupe_key'),
  },
  (t) => ({
    projectCreatedIdx: index('notifications_project_created_idx').on(t.projectId, t.createdAt),
    // cm:why ISS-1063 replaced `notifications_resolution_key_read_idx` with this one: the resolver's predicate is `resolution_key = $1 AND resolved_at IS NULL`, and `read` is not on this table any more to be the second column
    resolutionKeyActiveIdx: index('notifications_resolution_key_active_idx').on(
      t.resolutionKey,
      t.resolvedAt,
    ),
    // cm:guard alert-sweeper.ts's `INSERT ... ON CONFLICT (resolution_key) WHERE ...` infers THIS index, so its predicate must match verbatim or the insert throws. ISS-1063 dropped `user_id` from it because the record no longer belongs to a user — one active ops_alert per key, and the admins get a delivery each. The `type = 'ops_alert'` scope must stay: notify-transitions.ts legitimately left several active rows under one `issue:<id>:status` key, and an unscoped unique index would refuse to create over them and then silently drop.
    opsAlertActiveUq: uniqueIndex('notifications_ops_alert_active_uq')
      .on(t.resolutionKey)
      .where(sql`resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert'`),
    dedupeKeyIdx: index('notifications_dedupe_key_idx').on(t.dedupeKey),
    groupKeyIdx: index('notifications_group_key_idx').on(t.groupKey),
    stateIdx: index('notifications_kind_state_idx').on(t.kind, t.state),
    // cm:guard these four are what make a kind MEAN something rather than label something.
    // A signal with a resolution key is the exact defect ISS-1063 was filed about — 1771
    // `issue_status_changed` rows carried one — and a message in a code path only stops the
    // code paths that go through it. The constraint stops every writer, including a hand-run
    // UPDATE.
    signalHasNoResolveState: check(
      'notifications_signal_has_no_resolve_state',
      sql`kind <> 'signal' OR (resolution_key IS NULL AND resolved_at IS NULL)`,
    ),
    stateBelongsToKind: check(
      'notifications_state_belongs_to_kind',
      sql`(kind = 'signal' AND state IN ('emitted','expired')) OR (kind = 'condition' AND state IN ('pending','firing','inhibited','resolved')) OR (kind = 'task' AND state IN ('open','acknowledged','done','dismissed'))`,
    ),
    kindIsKnown: check('notifications_kind_is_known', sql`kind IN ('signal','condition','task')`),
    tierIsKnown: check('notifications_tier_is_known', sql`tier IN ('page','ticket','log')`),
  }),
);

export const notificationChannelValues = ['bell', 'toast', 'browser'] as const;

export const notificationsRelations = relations(notifications, ({ one }) => ({
  project: one(projects, { fields: [notifications.projectId], references: [projects.id] }),
  issue: one(issues, { fields: [notifications.issueId], references: [issues.id] }),
}));

/**
 * ISS-1063 — the DELIVERY layer: one person's copy of a record, on one channel.
 *
 * `read_at` lives here and nowhere else, because "has a human looked" is a fact about a
 * person and a record is not one. A delivery may carry SEVERAL records through
 * `notification_delivery_members`, which is what grouping is: one row in the bell naming
 * fifteen parks rather than fifteen rows.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: notificationChannelValues }).notNull().default('bell'),
    // cm:why the group key is on the delivery as well as on the record: the record says which evaluation raised it, and this says which delivery collapsed it, so a second evaluation finds the same (user, group) delivery and joins its records to that one instead of writing another row
    groupKey: text('group_key'),
    // cm:why ISS-1063 — the delivery's own headline. A grouped delivery names the CAUSE the fifteen records share ("15 issues are parked with merged code"); an ungrouped one carries its record's title, and a resolved notice says the condition ended. Deriving it from the members instead would pick one of fifteen titles at random and say nothing about how many there were.
    title: text('title'),
    // cm:guard `read_at` is the ONLY read state in this schema, and `resolved_at` on the record is the only "still true" state. The two answer different questions and belong to different owners; the whole of ISS-1063 is that they stopped sharing a row. Nothing may read one to answer the other.
    readAt: timestamp('read_at', { withTimezone: true }),
    // cm:why ISS-1063 — `send_resolved`: a delivery written to say the condition CLEARED, to the same people who were told it started. A record that never earned a delivery announces nothing when it clears.
    resolvedNotice: boolean('resolved_notice').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('notification_deliveries_user_created_idx').on(t.userId, t.createdAt),
    userReadIdx: index('notification_deliveries_user_read_idx').on(t.userId, t.readAt),
    userGroupUq: uniqueIndex('notification_deliveries_user_group_uq')
      .on(t.userId, t.groupKey, t.resolvedNotice)
      .where(sql`group_key IS NOT NULL`),
  }),
);

/** ISS-1063 — which records a delivery carries. One row for an ungrouped delivery. */
export const notificationDeliveryMembers = pgTable(
  'notification_delivery_members',
  {
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => notificationDeliveries.id, { onDelete: 'cascade' }),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.deliveryId, t.notificationId] }),
    notificationIdx: index('notification_delivery_members_notification_idx').on(t.notificationId),
  }),
);

/**
 * ISS-1063 — Alertmanager's silences: a matcher and a deadline, so an operator already
 * working on something can stop being told about it without turning a type off for
 * everybody and without anything having to remember to turn it back on.
 */
export const notificationSilences = pgTable(
  'notification_silences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', { enum: notificationTypes }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    resolutionKey: text('resolution_key'),
    reason: text('reason').notNull(),
    // cm:guard a silence with no deadline is a type turned off with nobody accountable for turning it back on, which is the defect this whole issue is about; `expires_at` is NOT NULL and no pass deletes an expired row, so the record of what was silenced and for how long survives the silence
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index('notification_silences_active_idx').on(t.expiresAt, t.type),
  }),
);

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
  user: one(users, { fields: [notificationDeliveries.userId], references: [users.id] }),
}));
