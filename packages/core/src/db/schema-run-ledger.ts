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
import { agentSessions, devices, projects } from './schema.js';

export const deviceRunLedger = pgTable(
  'device_run_ledger',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id'),
    /** The master the box says this run belongs to. A claim, not the record —
     *  `agent_sessions.parent_session_id` is the record. The foreign key is here
     *  so a claim naming a session core never issued cannot be stored at all;
     *  `applyRunLedgerSnapshot` refuses it by name before it gets this far, so
     *  the constraint is the floor rather than the error path. */
    masterSessionId: uuid('master_session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),
    pid: integer('pid'),
    worktreePath: text('worktree_path').notNull(),
    bootId: text('boot_id').notNull(),
    incarnation: text('incarnation').notNull(),
    work: text('work').notNull(),
    blockerKind: text('blocker_kind'),
    waitingOn: text('waiting_on'),
    sessionTerminalAt: timestamp('session_terminal_at', { withTimezone: true }),
    worktreeGoneAt: timestamp('worktree_gone_at', { withTimezone: true }),
    issues: jsonb('issues').$type<Array<{ issueKey: string; leaseReturned: boolean }>>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.deviceId, t.runId] }),
    projectIdx: index('device_run_ledger_project_idx').on(t.projectId),
  }),
);

export type DeviceRunLedgerRow = InferSelectModel<typeof deviceRunLedger>;
