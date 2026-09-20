/**
 * Who is working one issue, as a row a constraint can refuse (ISS-1109). The
 * primary key refuses a second taker, which no jsonb array element can;
 * `runIssues` remains the run's membership and says nothing about holders. The
 * holder is three foreign keys, so only a real session on a real box fits.
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
