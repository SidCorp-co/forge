import {
  STANDING_SUBJECT_KINDS,
  STEWARD_ACTS,
  STEWARD_FAILURE_KINDS,
  STEWARD_RUN_STATES,
  STEWARD_SKIP_REASONS,
  STEWARD_TRIGGERS,
  type StewardAct,
  type StewardCite,
  type StewardTrigger,
} from '@forge/contracts/steward';
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
import { users } from './schema-auth.js';
import { jobs } from './schema-jobs.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** One trigger folded into a run: the handoff, the outbox event that carried it, and when. */
export interface StewardRunEvent {
  trigger: StewardTrigger;
  outboxId: string;
  at: string;
}

/** The door that undoes an act, and the body it is called with (REQ-48 BC-12). */
export interface StewardUndo {
  door: string;
  body: Record<string, unknown> | null;
}

/**
 * One steward run on one item (REQ-48 BC-1), owned by the `steward` module. A live run (`queued` or
 * `running`) is the only one its subject holds, by the partial unique index; a trigger arriving while
 * one is queued folds into it (`acts_to_run`, `events`), and one arriving while it runs is kept in
 * `follow_up` / `follow_up_events`, which the run's end queues as the next run. `basis` is the
 * standing basis the run read, so the sweep starts no stuck diagnosis twice on the same basis.
 * `turns` counts the gateway turns it spent, which the daily budget sums.
 */
export const stewardRuns = pgTable(
  'steward_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    subjectKind: text('subject_kind', { enum: STANDING_SUBJECT_KINDS }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    subjectKey: text('subject_key').notNull(),
    trigger: text('trigger').$type<StewardTrigger>().notNull(),
    events: jsonb('events').$type<StewardRunEvent[]>().notNull(),
    actsToRun: text('acts_to_run').array().$type<StewardAct[]>().notNull(),
    followUp: text('follow_up')
      .array()
      .$type<StewardAct[]>()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    followUpEvents: jsonb('follow_up_events')
      .$type<StewardRunEvent[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    basis: text('basis'),
    state: text('state', { enum: STEWARD_RUN_STATES }).notNull().default('queued'),
    skipReason: text('skip_reason', { enum: STEWARD_SKIP_REASONS }),
    failure: text('failure'),
    /** Why it failed (`STEWARD_FAILURE_KINDS`): a refused act is not tried again on the same basis. */
    failureKind: text('failure_kind', { enum: STEWARD_FAILURE_KINDS }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    turnId: uuid('turn_id'),
    turns: integer('turns').notNull().default(0),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    liveUq: uniqueIndex('steward_runs_live_uq')
      .on(t.subjectKind, t.subjectId)
      .where(sql`state IN ('queued', 'running')`),
    projectQueuedIdx: index('steward_runs_project_queued_idx').on(t.projectId, t.queuedAt),
    dueIdx: index('steward_runs_due_idx').on(t.notBefore).where(sql`state = 'queued'`),
    jobIdx: index('steward_runs_job_idx').on(t.jobId).where(sql`job_id IS NOT NULL`),
    subjectIdx: index('steward_runs_subject_idx').on(t.subjectKind, t.subjectId, t.queuedAt),
    subjectKindChk: check(
      'steward_runs_subject_kind_chk',
      sql`${t.subjectKind} IN (${inList(STANDING_SUBJECT_KINDS)})`,
    ),
    triggerChk: check(
      'steward_runs_trigger_chk',
      sql`${t.trigger} IN (${inList(STEWARD_TRIGGERS)})`,
    ),
    stateChk: check('steward_runs_state_chk', sql`${t.state} IN (${inList(STEWARD_RUN_STATES)})`),
    skipReasonChk: check(
      'steward_runs_skip_reason_chk',
      sql`${t.skipReason} IS NULL OR ${t.skipReason} IN (${inList(STEWARD_SKIP_REASONS)})`,
    ),
    actsChk: check(
      'steward_runs_acts_chk',
      sql`cardinality(${t.actsToRun}) >= 1 AND ${t.actsToRun} <@ ARRAY[${inList(STEWARD_ACTS)}]::text[] AND ${t.followUp} <@ ARRAY[${inList(STEWARD_ACTS)}]::text[]`,
    ),
    skipChk: check(
      'steward_runs_skip_chk',
      sql`(${t.state} = 'skipped') = (${t.skipReason} IS NOT NULL)`,
    ),
    failureChk: check(
      'steward_runs_failure_chk',
      sql`(${t.state} = 'failed') = (${t.failure} IS NOT NULL)`,
    ),
    failureKindChk: check(
      'steward_runs_failure_kind_chk',
      sql`${t.failureKind} IS NULL OR ${t.failureKind} IN (${inList(STEWARD_FAILURE_KINDS)})`,
    ),
    failureKindSetChk: check(
      'steward_runs_failure_kind_set_chk',
      sql`(${t.state} = 'failed') = (${t.failureKind} IS NOT NULL)`,
    ),
    turnsChk: check('steward_runs_turns_chk', sql`${t.turns} >= 0`),
    eventsChk: check(
      'steward_runs_events_chk',
      sql`jsonb_typeof(${t.events}) = 'array' AND jsonb_typeof(${t.followUpEvents}) = 'array'`,
    ),
  }),
);

/**
 * One act a steward run took through an existing door (REQ-48 BC-12), insert-only but for its undo
 * stamp: the door, what it did in one BA sentence, what it wrote and the door that undoes it. An act
 * that asked the project's master to move (`master_ask`) stands as `stewardAsks` until the sweep sees
 * its subject's standing move (`ask_settled_at`). `undo_wrote` names the record the undo itself wrote,
 * so the steward never checks a person's override as if it were new work.
 */
export const stewardActs = pgTable(
  'steward_acts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => stewardRuns.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    act: text('act', { enum: STEWARD_ACTS }).notNull(),
    door: text('door').notNull(),
    did: text('did').notNull(),
    wrote: jsonb('wrote').$type<StewardCite | null>(),
    undo: jsonb('undo').$type<StewardUndo | null>(),
    masterAsk: text('master_ask'),
    askSettledAt: timestamp('ask_settled_at', { withTimezone: true }),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: uuid('undone_by').references(() => users.id, { onDelete: 'set null' }),
    undoWrote: text('undo_wrote'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('steward_acts_run_idx').on(t.runId, t.at),
    askIdx: index('steward_acts_open_ask_idx')
      .on(t.projectId)
      .where(sql`master_ask IS NOT NULL AND ask_settled_at IS NULL AND undone_at IS NULL`),
    actChk: check('steward_acts_act_chk', sql`${t.act} IN (${inList(STEWARD_ACTS)})`),
    undoChk: check('steward_acts_undo_chk', sql`${t.undoneAt} IS NULL OR ${t.undo} IS NOT NULL`),
  }),
);

/**
 * The one agent account each project's steward acts as (REQ-48 BC-1), minted lazily on the project's
 * first steward run and a member of that project with its grants. Kept apart from the project's
 * conversation handle, which is also an agent member of one project (`conversations/handles.ts`).
 */
export const stewardAccounts = pgTable(
  'steward_accounts',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userUq: uniqueIndex('steward_accounts_user_uq').on(t.userId),
  }),
);
