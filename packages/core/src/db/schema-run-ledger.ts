/**
 * `device_run_ledger` — what one box says its own session registry holds
 * (ISS-934), split out of `schema.ts` for the reason `schema-activity.ts`
 * states: that file is frozen far over the file budget, so a new table cannot
 * land there without an amnesty.
 *
 * A MIRROR, and only of facts core cannot otherwise have: the parent master, a
 * pid, a worktree path, a boot, and the box's own reading of whether a run can
 * move. Status, membership and last activity stay on `agent_sessions` /
 * `pipeline_runs.metadata.runIssues`, which core owns.
 */

import type { InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { devices, projects } from './schema.js';

// cm:guard nothing here is read as the truth about a RUN — `session_id` and `master_session_id` are pointers into `agent_sessions`, never a second copy of what those rows say. A column that restates a status core already owns gives the fact two writers and the losing one is invisible.
// cm:guard `observed_at` is the whole staleness signal, because a box that dies stops writing rather than writing that it died. A reader that drops it presents a dead box's last snapshot as current, which is the inversion this table exists to remove.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/session_ledger.rs — every column below is one field of that snapshot; the two are one wire format and nothing type-checks the pair.
export const deviceRunLedger = pgTable(
  'device_run_ledger',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    // cm:guard the BOX's run id and deliberately not a uuid column — it is an opaque key minted on the box, and the primary key is (device, run) because two boxes may mint the same string and neither is wrong.
    runId: text('run_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // cm:guard NO foreign key to `agent_sessions`, on either of these. A box reports the whole of its registry in one statement, and a run naming a session core's reaper has already removed would fail that statement and take every OTHER run on the box down with it — the box would then read as holding nothing.
    sessionId: uuid('session_id'),
    masterSessionId: uuid('master_session_id'),
    pid: integer('pid'),
    worktreePath: text('worktree_path').notNull(),
    bootId: text('boot_id').notNull(),
    incarnation: text('incarnation').notNull(),
    work: text('work').notNull(),
    blockerKind: text('blocker_kind'),
    waitingOn: text('waiting_on'),
    issues: jsonb('issues').$type<Array<{ issueKey: string; leaseReturned: boolean }>>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.deviceId, t.runId] }),
    projectIdx: index('device_run_ledger_project_idx').on(t.projectId),
  }),
);

export type DeviceRunLedgerRow = InferSelectModel<typeof deviceRunLedger>;
