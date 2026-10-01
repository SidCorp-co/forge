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
import { projects, users } from './schema.js';

export const projectWorkflows = pgTable(
  'project_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    flow: text('flow').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    refreshedAtSha: text('refreshed_at_sha').notNull(),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    writtenByUser: uuid('written_by_user')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    flowUq: uniqueIndex('project_workflows_flow_uq').on(t.projectId, t.flow),
    projectIdx: index('project_workflows_project_idx').on(t.projectId, t.kind),
    kindChk: check('project_workflows_kind_chk', sql`${t.kind} IN ('flow', 'state')`),
    statusChk: check(
      'project_workflows_status_chk',
      sql`${t.status} IN ('writing', 'current', 'rechecking')`,
    ),
    shaChk: check('project_workflows_sha_chk', sql`${t.refreshedAtSha} ~ '^[0-9a-f]{40}$'`),
    revisionChk: check('project_workflows_revision_chk', sql`${t.revision} >= 1`),
  }),
);
