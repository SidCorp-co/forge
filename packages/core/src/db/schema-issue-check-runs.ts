import { CHECK_KINDS, CHECK_RUN_RESULTS, CHECK_RUN_VIAS } from '@forge/contracts/check-runs';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues, users } from './schema.js';

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// The checks a run made on an issue, each with its kind and duration (REQ-36 BC-14; Issue to release
// r20 `act-build`, `rule-merge`; ISS-474), written by the issue kernel (`issues/check-runs.ts`). The
// id is the one the script that ran the check gave it, so a resend is the same row and one check is
// one record. `run_session_id` is the run session holding the issue on the box that sent it, null
// for a call from no run; no FK, since a cascade that nulled it would be an UPDATE the guard refuses,
// and a session goes only with its project, which takes the issue and these rows with it.
// `issue_check_run_guard()` (0476) refuses every UPDATE: a timed check is written once.
export const issueCheckRuns = pgTable(
  'issue_check_runs',
  {
    id: uuid('id').primaryKey(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: CHECK_KINDS }).notNull(),
    name: text('name').notNull(),
    scope: text('scope').notNull(),
    command: text('command').notNull(),
    files: jsonb('files').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    result: text('result', { enum: CHECK_RUN_RESULTS }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    headSha: text('head_sha').notNull(),
    note: text('note'),
    runSessionId: uuid('run_session_id'),
    via: text('via', { enum: CHECK_RUN_VIAS }).notNull(),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recordedAgency: text('recorded_agency', { enum: ['human', 'agent'] }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('issue_check_runs_issue_idx').on(t.issueId, t.startedAt),
    kindChk: check('issue_check_runs_kind_chk', sql`${t.kind} IN (${quoted(CHECK_KINDS)})`),
    resultChk: check(
      'issue_check_runs_result_chk',
      sql`${t.result} IN (${quoted(CHECK_RUN_RESULTS)})`,
    ),
    viaChk: check('issue_check_runs_via_chk', sql`${t.via} IN (${quoted(CHECK_RUN_VIAS)})`),
    durationChk: check('issue_check_runs_duration_chk', sql`${t.durationMs} >= 0`),
    headChk: check('issue_check_runs_head_chk', sql`${t.headSha} ~ '^[0-9a-f]{40}$'`),
    filesChk: check('issue_check_runs_files_chk', sql`jsonb_typeof(${t.files}) = 'array'`),
    agencyChk: check(
      'issue_check_runs_agency_chk',
      sql`${t.recordedAgency} IS NULL OR ${t.recordedAgency} IN ('human', 'agent')`,
    ),
  }),
);
