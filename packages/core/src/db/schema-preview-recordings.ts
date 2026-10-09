import {
  RECORDING_FAILURE_REASONS,
  RECORDING_STATES,
  type TimelineEntry,
} from '@forge/contracts/reproduce';
import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { users } from './schema-auth.js';
import { feedback } from './schema-feedback.js';
import { previews } from './schema-previews.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// What a member did in a reproduce preview (REQ-41 BC-18, 0479), recorded by the recorder the relay
// injects. `state` is RECORDING_MACHINE's, written only by the kernel transition (0479 guards it).
// The raw events are gzip segments in the uploads store (`segments`, deleted at `expires_at`); the
// `timeline` is what the assistant and the feedback page read, kept until the reporter data is
// redacted. `next_seq` is the batch the recorder owes next: a gap or a repeat is refused.
export const previewRecordings = pgTable(
  'preview_recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    previewId: uuid('preview_id')
      .notNull()
      .references(() => previews.id, { onDelete: 'cascade' }),
    buildSha: text('build_sha').notNull(),
    buildRelease: text('build_release'),
    state: text('state', { enum: RECORDING_STATES }).notNull().default('recording'),
    reason: text('reason', { enum: RECORDING_FAILURE_REASONS }),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nextSeq: integer('next_seq').notNull().default(0),
    events: integer('events').notNull().default(0),
    bytes: integer('bytes').notNull().default(0),
    /** The timestamp of the first event, in the page's milliseconds: timeline `at` counts from it. */
    firstEventAt: bigint('first_event_at', { mode: 'number' }),
    /** The uploads-store paths of the gzip segments, oldest first. */
    segments: jsonb('segments').$type<string[]>().notNull().default([]),
    timeline: jsonb('timeline').$type<TimelineEntry[]>().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastBatchAt: timestamp('last_batch_at', { withTimezone: true }),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => ({
    oneOpenPerViewerUq: uniqueIndex('preview_recordings_one_open_uq')
      .on(t.previewId, t.recordedBy)
      .where(sql`state = 'recording'`),
    feedbackIdx: index('preview_recordings_feedback_idx').on(t.feedbackId, t.startedAt),
    stateIdx: index('preview_recordings_state_idx').on(t.state),
    stateChk: check(
      'preview_recordings_state_chk',
      sql`${t.state} IN (${inList(RECORDING_STATES)})`,
    ),
    reasonChk: check(
      'preview_recordings_reason_chk',
      sql`${t.reason} IS NULL OR ${t.reason} IN (${inList(RECORDING_FAILURE_REASONS)})`,
    ),
    failedReasonChk: check(
      'preview_recordings_failed_reason_chk',
      sql`(${t.state} = 'failed') = (${t.reason} IS NOT NULL)`,
    ),
    shaChk: check('preview_recordings_sha_chk', sql`${t.buildSha} ~ '^[0-9a-f]{40}$'`),
    sizeChk: check(
      'preview_recordings_size_chk',
      sql`${t.events} >= 0 AND ${t.bytes} BETWEEN 0 AND 52428800 AND ${t.nextSeq} >= 0`,
    ),
  }),
);

export type PreviewRecordingRow = typeof previewRecordings.$inferSelect;

// A reporter's word on a fix preview (REQ-41 BC-20, 0479), bound to the patch id the preview served
// when they gave it: the feedback item's loop close reads the latest (`loopCloseFromConfirm`).
export const previewFixConfirmations = pgTable(
  'preview_fix_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    previewId: uuid('preview_id')
      .notNull()
      .references(() => previews.id, { onDelete: 'cascade' }),
    patchId: text('patch_id').notNull(),
    verdict: text('verdict', { enum: ['fixed', 'not_fixed'] }).notNull(),
    note: text('note'),
    by: uuid('by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedbackIdx: index('preview_fix_confirmations_feedback_idx').on(t.feedbackId, t.at),
    verdictChk: check(
      'preview_fix_confirmations_verdict_chk',
      sql`${t.verdict} IN ('fixed', 'not_fixed')`,
    ),
    patchChk: check('preview_fix_confirmations_patch_chk', sql`${t.patchId} ~ '^[0-9a-f]{40}$'`),
    noteChk: check(
      'preview_fix_confirmations_note_chk',
      sql`${t.verdict} = 'fixed' OR (${t.note} IS NOT NULL AND length(${t.note}) > 0)`,
    ),
  }),
);

export type PreviewFixConfirmationRow = typeof previewFixConfirmations.$inferSelect;
