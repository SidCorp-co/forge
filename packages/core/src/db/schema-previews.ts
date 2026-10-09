import type { LaneDecision } from '@forge/contracts/fast-lane';
import {
  PREVIEW_FAILURE_REASONS,
  PREVIEW_STATES,
  PREVIEW_SUBJECT_KINDS,
  type PreviewCheckout,
  type PreviewSubject,
} from '@forge/contracts/preview';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';
import { users } from './schema-auth.js';
import { devices } from './schema-devices.js';
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// A run's dev server served to the project's members from a Forge link (REQ-39,
// docs/proposals/live-preview.md). `state` is PREVIEW_MACHINE's, written only by the kernel
// transition (0477 guards it); `slug` is the host label under PREVIEW_DOMAIN. One open preview per
// session: a run holds one preview at a time. What it serves is `subject_kind` (REQ-41, 0479): an
// issue's run (`issue_id` and `session_id`), an idea's sketch run (`session_id`, no issue) or a past
// build of a feedback item (`feedback_id`, no run); the last two carry the `subject` and the
// `checkout` the box cuts, both named by core.
export const previews = pgTable(
  'previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    subjectKind: text('subject_kind', { enum: PREVIEW_SUBJECT_KINDS }).notNull().default('issue'),
    /** The idea or reproduce subject; null for an issue's run, whose subject is `issue_id`. */
    subject: jsonb('subject').$type<Exclude<PreviewSubject, { kind: 'issue' }>>(),
    /** The checkout the box cuts for an idea or a reproduce; null where a run's worktree is served. */
    checkout: jsonb('checkout').$type<PreviewCheckout>(),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'cascade' }),
    /** The feedback item a reproduce serves the build of. */
    feedbackId: uuid('feedback_id').references(() => feedback.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    state: text('state', { enum: PREVIEW_STATES }).notNull().default('starting'),
    reason: text('reason', { enum: PREVIEW_FAILURE_REASONS }),
    detail: text('detail'),
    command: text('command').notNull(),
    port: integer('port'),
    idleMinutes: integer('idle_minutes').notNull(),
    approvedPatchId: text('approved_patch_id'),
    approvedFiles: jsonb('approved_files').$type<string[]>(),
    laneDecision: jsonb('lane_decision').$type<LaneDecision>(),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    liveAt: timestamp('live_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    slugUq: uniqueIndex('previews_slug_uq').on(t.slug),
    oneOpenPerSessionUq: uniqueIndex('previews_one_open_per_session_uq')
      .on(t.sessionId)
      .where(sql`state IN ('starting', 'live', 'idle_closed')`),
    issueIdx: index('previews_issue_idx').on(t.issueId, t.createdAt),
    deviceIdx: index('previews_device_idx').on(t.deviceId),
    feedbackIdx: index('previews_feedback_idx').on(t.feedbackId),
    subjectKindChk: check(
      'previews_subject_kind_chk',
      sql`${t.subjectKind} IN (${inList(PREVIEW_SUBJECT_KINDS)})`,
    ),
    subjectChk: check(
      'previews_subject_chk',
      sql`(${t.subjectKind} = 'issue' AND ${t.issueId} IS NOT NULL AND ${t.sessionId} IS NOT NULL AND ${t.subject} IS NULL AND ${t.checkout} IS NULL AND ${t.feedbackId} IS NULL)
        OR (${t.subjectKind} = 'idea' AND ${t.issueId} IS NULL AND ${t.sessionId} IS NOT NULL AND ${t.subject} IS NOT NULL AND ${t.checkout} IS NOT NULL)
        OR (${t.subjectKind} = 'reproduce' AND ${t.issueId} IS NULL AND ${t.sessionId} IS NULL AND ${t.subject} IS NOT NULL AND ${t.checkout} IS NOT NULL AND ${t.feedbackId} IS NOT NULL)`,
    ),
    stateChk: check('previews_state_chk', sql`${t.state} IN (${inList(PREVIEW_STATES)})`),
    reasonChk: check(
      'previews_reason_chk',
      sql`${t.reason} IS NULL OR ${t.reason} IN (${inList(PREVIEW_FAILURE_REASONS)})`,
    ),
    failedReasonChk: check(
      'previews_failed_reason_chk',
      sql`(${t.state} = 'failed') = (${t.reason} IS NOT NULL)`,
    ),
    slugChk: check('previews_slug_chk', sql`${t.slug} ~ '^p-[a-z2-7]{16}$'`),
    portChk: check('previews_port_chk', sql`${t.port} IS NULL OR ${t.port} BETWEEN 1024 AND 65535`),
    idleChk: check('previews_idle_chk', sql`${t.idleMinutes} BETWEEN 5 AND 240`),
    patchChk: check(
      'previews_patch_chk',
      sql`${t.approvedPatchId} IS NULL OR ${t.approvedPatchId} ~ '^[0-9a-f]{40}$'`,
    ),
    approvedChk: check(
      'previews_approved_chk',
      sql`(${t.state} = 'approved') = (${t.approvedPatchId} IS NOT NULL)`,
    ),
  }),
);

export type PreviewRow = typeof previews.$inferSelect;
