import type { BoxViewCodec } from '@forge/contracts/box-wire';
import {
  BOX_ACT_VIA,
  BOX_CLOSED_WHY,
  BOX_FAILURES,
  BOX_MODES,
  BOX_RECORDING_WHY,
  BOX_SESSION_FAULTS,
  BOX_SESSION_STATES,
  BOX_STATES,
  type BoxMode,
  type BoxQueuePlace,
} from '@forge/contracts/boxes';
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { devices } from './schema-devices.js';
import { issueAttachments, issues } from './schema-issues.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const BOX_RECORDING_STATES = ['recording', 'kept', 'dropped'] as const;
export const BOX_ACT_BY = ['agent', 'person'] as const;
export const BOX_ACT_KINDS = ['read', 'write', 'input'] as const;
export const BOX_ACT_STATES = ['pending', 'done', 'failed', 'refused'] as const;
export const BOX_SPAN_STATES = ['open', 'cutting', 'attached', 'failed'] as const;

// A Forge Box (ISS-1276, ADR 0015): a screen an agent tests a UI in on one device, which a person
// watches and takes. `state` is BOX_MACHINE's, written only by the kernel transition; who holds it
// is the state (`agent` / `person`), with the person in `held_by` and the agent's run in `run_id`.
// A waiting box is a request the device's health has no room for yet; `asked_at` orders the queue.
// The issue's lifecycle owns its boxes and their recordings: deleting the issue deletes them.
export const boxes = pgTable(
  'boxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** Null for a warm box nobody's work holds yet. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    criterion: integer('criterion'),
    mode: text('mode', { enum: BOX_MODES }).notNull().$type<BoxMode>(),
    state: text('state', { enum: BOX_STATES }).notNull().default('waiting'),
    /** Who holds it once it runs: the agent's run, or the person who opened it to test by hand. */
    openedAs: text('opened_as', { enum: BOX_ACT_BY }).notNull().default('agent'),
    runId: text('run_id'),
    heldBy: uuid('held_by').references(() => users.id, { onDelete: 'set null' }),
    heldSince: timestamp('held_since', { withTimezone: true }),
    /** A person's newest input; their hold expires `holdIdleSeconds` after it. */
    lastInputAt: timestamp('last_input_at', { withTimezone: true }),
    /** Where a waiting box stands, as the last allocation placed it; null once it starts. */
    queue: jsonb('queue').$type<BoxQueuePlace>(),
    viewport: jsonb('viewport').$type<{ width: number; height: number }>(),
    url: text('url'),
    view: jsonb('view').$type<{ codec: BoxViewCodec; width: number; height: number }>(),
    /**
     * Where the device's CDP proxy answers for a browser box (ISS-1322), as its `ready` said: a
     * loopback URL, handed only to an agent on that device (`attachBox`), never on the record.
     */
    attach: jsonb('attach').$type<{ cdp: string }>(),
    recordingState: text('recording_state', { enum: BOX_RECORDING_STATES }),
    /**
     * Who wants it recording (ISS-1321): an open or an agent that asked, a criterion's span, or a
     * person on the Boxes page; null when nobody does, and nothing records by default.
     */
    recordingWhy: text('recording_why', { enum: BOX_RECORDING_WHY }),
    recordingStartedAt: timestamp('recording_started_at', { withTimezone: true }),
    /**
     * A person or the open asked for its recording (ISS-1338): only such a recording is sent to Forge
     * once the box ends, never a span's own.
     */
    recordingAsked: boolean('recording_asked').notNull().default(false),
    /** The kept recording sent to Forge (ISS-1338): sending, attached (clip and still), or failed. */
    sessionState: text('session_state', { enum: BOX_SESSION_STATES }),
    sessionAt: timestamp('session_at', { withTimezone: true }),
    sessionClipId: uuid('session_clip_id').references(() => issueAttachments.id, {
      onDelete: 'set null',
    }),
    sessionStillId: uuid('session_still_id').references(() => issueAttachments.id, {
      onDelete: 'set null',
    }),
    sessionFault: text('session_fault', { enum: BOX_SESSION_FAULTS }),
    sessionDetail: text('session_detail'),
    failure: text('failure', { enum: BOX_FAILURES }),
    detail: text('detail'),
    actSeq: integer('act_seq').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Why it closed: by a caller (`done`), or by the sweep once nothing used it (`idle`, ISS-1335). */
    closedWhy: text('closed_why', { enum: BOX_CLOSED_WHY }),
  },
  (t) => ({
    deviceStateIdx: index('boxes_device_state_idx').on(t.deviceId, t.state),
    projectIdx: index('boxes_project_idx').on(t.projectId, t.askedAt),
    issueIdx: index('boxes_issue_idx').on(t.issueId),
    modeChk: check('boxes_mode_chk', sql`${t.mode} IN (${inList(BOX_MODES)})`),
    stateChk: check('boxes_state_chk', sql`${t.state} IN (${inList(BOX_STATES)})`),
    heldChk: check(
      'boxes_held_chk',
      sql`(${t.state} = 'person') = (${t.heldBy} IS NOT NULL AND ${t.heldSince} IS NOT NULL)`,
    ),
    warmChk: check(
      'boxes_warm_chk',
      sql`${t.state} <> 'warm' OR (${t.projectId} IS NULL AND ${t.issueId} IS NULL)`,
    ),
    openedAsChk: check('boxes_opened_as_chk', sql`${t.openedAs} IN (${inList(BOX_ACT_BY)})`),
    failedChk: check('boxes_failed_chk', sql`(${t.state} = 'failed') = (${t.failure} IS NOT NULL)`),
    failureChk: check(
      'boxes_failure_chk',
      sql`${t.failure} IS NULL OR ${t.failure} IN (${inList(BOX_FAILURES)})`,
    ),
    closedWhyChk: check(
      'boxes_closed_why_chk',
      sql`(${t.state} = 'closed') = (${t.closedWhy} IS NOT NULL) AND (${t.closedWhy} IS NULL OR ${t.closedWhy} IN (${inList(BOX_CLOSED_WHY)}))`,
    ),
    sessionChk: check(
      'boxes_session_chk',
      sql`(${t.sessionState} IS NULL OR ${t.sessionState} IN (${inList(BOX_SESSION_STATES)})) AND (${t.sessionState} IS NULL) = (${t.sessionAt} IS NULL) AND (${t.sessionState} IS NOT DISTINCT FROM 'failed') = (${t.sessionFault} IS NOT NULL) AND (${t.sessionFault} IS NULL OR ${t.sessionFault} IN (${inList(BOX_SESSION_FAULTS)}))`,
    ),
    recordingWhyChk: check(
      'boxes_recording_why_chk',
      sql`${t.recordingWhy} IS NULL OR ${t.recordingWhy} IN (${inList(BOX_RECORDING_WHY)})`,
    ),
  }),
);

/** Every act on a box in the order the box got it: the agent's commands and the person's input. */
export const boxActs = pgTable(
  'box_acts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => boxes.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    by: text('by', { enum: BOX_ACT_BY }).notNull(),
    actor: text('actor').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: BOX_ACT_KINDS }).notNull(),
    /** How it reached the box: the act door, a person's input socket, or an attached CDP session. */
    via: text('via', { enum: BOX_ACT_VIA }).notNull(),
    command: jsonb('command').$type<string[]>().notNull(),
    state: text('state', { enum: BOX_ACT_STATES }).notNull(),
    exitCode: integer('exit_code'),
    stdout: text('stdout'),
    stderr: text('stderr'),
    durationMs: integer('duration_ms'),
    refusal: text('refusal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => ({
    seqUq: uniqueIndex('box_acts_seq_uq').on(t.boxId, t.seq),
    byChk: check('box_acts_by_chk', sql`${t.by} IN (${inList(BOX_ACT_BY)})`),
    kindChk: check('box_acts_kind_chk', sql`${t.kind} IN (${inList(BOX_ACT_KINDS)})`),
    viaChk: check('box_acts_via_chk', sql`${t.via} IN (${inList(BOX_ACT_VIA)})`),
    stateChk: check('box_acts_state_chk', sql`${t.state} IN (${inList(BOX_ACT_STATES)})`),
  }),
);

/** A criterion's span on a box's recording, and the clip and still the device cut from it. */
export const boxSpans = pgTable(
  'box_spans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boxId: uuid('box_id')
      .notNull()
      .references(() => boxes.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    criterion: integer('criterion').notNull(),
    state: text('state', { enum: BOX_SPAN_STATES }).notNull().default('open'),
    startOffsetMs: integer('start_offset_ms'),
    endOffsetMs: integer('end_offset_ms'),
    clipAttachmentId: uuid('clip_attachment_id').references(() => issueAttachments.id, {
      onDelete: 'set null',
    }),
    stillAttachmentId: uuid('still_attachment_id').references(() => issueAttachments.id, {
      onDelete: 'set null',
    }),
    detail: text('detail'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    boxIdx: index('box_spans_box_idx').on(t.boxId, t.criterion),
    issueIdx: index('box_spans_issue_idx').on(t.issueId, t.criterion),
    oneOpenUq: uniqueIndex('box_spans_one_open_uq')
      .on(t.boxId, t.criterion)
      .where(sql`state = 'open'`),
    stateChk: check('box_spans_state_chk', sql`${t.state} IN (${inList(BOX_SPAN_STATES)})`),
  }),
);

export type BoxRow = typeof boxes.$inferSelect;
export type BoxActRow = typeof boxActs.$inferSelect;
export type BoxSpanRow = typeof boxSpans.$inferSelect;
