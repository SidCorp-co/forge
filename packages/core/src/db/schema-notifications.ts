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
  'issue_stranded',
  'retry_rescue_threshold',
  'ops_alert',
] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const notificationKindValues = ['signal', 'condition', 'task'] as const;
export const notificationTierValues = ['page', 'ticket', 'log'] as const;

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type', { enum: notificationTypes }).notNull(),
    kind: text('kind', { enum: notificationKindValues }).notNull(),
    tier: text('tier', { enum: notificationTierValues }).notNull(),
    state: text('state').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    // ISS-510 — per-event severity (from the `@forge/contracts` notification
    // contract) drives toast tone + bell hue. Nullable: legacy rows predate it.
    severity: text('severity'),
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
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    pendingSince: timestamp('pending_since', { withTimezone: true }),
    groupKey: text('group_key'),
    inhibitedBy: uuid('inhibited_by'),
    dedupeKey: text('dedupe_key'),
  },
  (t) => ({
    projectCreatedIdx: index('notifications_project_created_idx').on(t.projectId, t.createdAt),
    resolutionKeyActiveIdx: index('notifications_resolution_key_active_idx').on(
      t.resolutionKey,
      t.resolvedAt,
    ),
    opsAlertActiveUq: uniqueIndex('notifications_ops_alert_active_uq')
      .on(t.resolutionKey)
      .where(sql`resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert'`),
    dedupeKeyIdx: index('notifications_dedupe_key_idx').on(t.dedupeKey),
    groupKeyIdx: index('notifications_group_key_idx').on(t.groupKey),
    stateIdx: index('notifications_kind_state_idx').on(t.kind, t.state),
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
    groupKey: text('group_key'),
    title: text('title'),
    readAt: timestamp('read_at', { withTimezone: true }),
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
