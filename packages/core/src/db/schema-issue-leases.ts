/**
 * Who is working one issue, as a row a constraint can refuse (ISS-1109).
 *
 * Held-ness used to be derived from `pipeline_runs.metadata -> 'runIssues'`, a
 * jsonb array. No index constrains an array element, so nothing refused the
 * second taker and two boxes could hold one issue at once. The primary key
 * below is what refuses it; `runIssues` stays as the run's membership record
 * and says nothing about who holds what.
 *
 * The holder is three foreign keys rather than a string, so nothing but a real
 * run session on a real box can be recorded as holding an issue: the wave id
 * that stranded ISS-1105 and ISS-1111 on 2026-09-20 has nowhere to go here.
 */

import { relations } from 'drizzle-orm';
import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agentSessions, devices, pipelineRuns, projects } from './schema.js';

export const issueLeases = pgTable(
  'issue_leases',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The canonical `ISS-<seq>` key, never the project's own prefix (ISS-992). */
    issueKey: text('issue_key').notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.issueKey] }),
    bySession: index('issue_leases_session_idx').on(t.sessionId),
    byDevice: index('issue_leases_device_idx').on(t.deviceId),
  }),
);

export const issueLeasesRelations = relations(issueLeases, ({ one }) => ({
  project: one(projects, { fields: [issueLeases.projectId], references: [projects.id] }),
  device: one(devices, { fields: [issueLeases.deviceId], references: [devices.id] }),
  session: one(agentSessions, {
    fields: [issueLeases.sessionId],
    references: [agentSessions.id],
  }),
  run: one(pipelineRuns, { fields: [issueLeases.runId], references: [pipelineRuns.id] }),
}));
