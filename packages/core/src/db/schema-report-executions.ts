import { EXECUTION_LANGUAGES, EXECUTION_LIMITS } from '@forge/contracts/report-executions';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { conversations } from './schema-conversations.js';
import { projects } from './schema-projects.js';

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One execution of a script by a sandbox executor (`reports/executions.ts:recordExecution`): who
 * asked and through which turn, the script and its fingerprint, the report runs it read, the limits
 * it ran under, and what came back with frames and logs capped and the logs scrubbed. A block drawn
 * from it names it by `id` and is labelled computed. Kept until `expires_at`, 30 days after it ran,
 * then swept (`reports/sweep.ts`); `script_fingerprint` lets a script asked again be counted (C5).
 */
export const reportExecutions = pgTable(
  'report_executions',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The room a chat turn asked from; null for an Agent session's REST call. */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** The credential the asking turn acted under, which the per-turn caps are counted by. */
    turnKey: text('turn_key').notNull(),
    askedBy: uuid('asked_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    askedAgency: text('asked_agency', { enum: ['human', 'agent'] }).notNull(),
    adapter: text('adapter').notNull(),
    /** The adapter's own id for the execution, where it gave one. */
    adapterExecutionId: text('adapter_execution_id'),
    language: text('language', { enum: EXECUTION_LANGUAGES }).notNull(),
    script: text('script').notNull(),
    scriptFingerprint: text('script_fingerprint').notNull(),
    inputRunIds: uuid('input_run_ids').array().notNull(),
    limits: jsonb('limits').notNull(),
    exit: integer('exit').notNull(),
    stopped: text('stopped', { enum: EXECUTION_LIMITS }),
    durationMs: real('duration_ms').notNull(),
    /** The bytes of frames and logs kept, which the per-turn output cap is counted by. */
    outputBytes: integer('output_bytes').notNull(),
    frames: jsonb('frames').notNull(),
    logs: jsonb('logs').notNull(),
    error: jsonb('error'),
    /** Every read the script made of Forge through ctx.forge.get, with its status (REQ-37 BC-9). */
    reads: jsonb('reads').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    projectCreatedIdx: index('report_executions_project_created_idx').on(t.projectId, t.createdAt),
    expiresIdx: index('report_executions_expires_idx').on(t.expiresAt),
    turnIdx: index('report_executions_turn_idx').on(t.turnKey, t.createdAt),
    fingerprintIdx: index('report_executions_fingerprint_idx').on(t.projectId, t.scriptFingerprint),
    agencyChk: check('report_executions_agency_chk', sql`${t.askedAgency} IN ('human', 'agent')`),
    languageChk: check(
      'report_executions_language_chk',
      sql`${t.language} IN (${quoted(EXECUTION_LANGUAGES)})`,
    ),
    stoppedChk: check(
      'report_executions_stopped_chk',
      sql`${t.stopped} IS NULL OR ${t.stopped} IN (${quoted(EXECUTION_LIMITS)})`,
    ),
    fingerprintChk: check(
      'report_executions_fingerprint_chk',
      sql`${t.scriptFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    keepChk: check('report_executions_keep_chk', sql`${t.expiresAt} > ${t.createdAt}`),
    durationChk: check('report_executions_duration_chk', sql`${t.durationMs} >= 0`),
    outputChk: check('report_executions_output_chk', sql`${t.outputBytes} >= 0`),
    limitsChk: check('report_executions_limits_chk', sql`jsonb_typeof(${t.limits}) = 'object'`),
    framesChk: check('report_executions_frames_chk', sql`jsonb_typeof(${t.frames}) = 'array'`),
    logsChk: check('report_executions_logs_chk', sql`jsonb_typeof(${t.logs}) = 'object'`),
    readsChk: check('report_executions_reads_chk', sql`jsonb_typeof(${t.reads}) = 'array'`),
  }),
);
