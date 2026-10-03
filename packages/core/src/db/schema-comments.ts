import { COMMENT_EVENT_KINDS, type DecisionFields } from '@forge/contracts/comments';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { comments, projects, users } from './schema.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// cm:why a comment on a requirement, design or feedback item has no issue to carry an activity row,
// so its post and every edit are a typed row here holding the content as it stood: an edited
// decision keeps what it replaced. Insert-only by comment_event_guard(), removed only with its comment
export const commentEvents = pgTable(
  'comment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: COMMENT_EVENT_KINDS }).notNull(),
    body: text('body').notNull(),
    decision: jsonb('decision').$type<DecisionFields>(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    actorAgency: text('actor_agency', { enum: ['human', 'agent'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindChk: check('comment_events_kind_chk', sql`${t.kind} IN (${inList(COMMENT_EVENT_KINDS)})`),
    agencyChk: check('comment_events_agency_chk', sql`${t.actorAgency} IN ('human', 'agent')`),
    commentIdx: index('comment_events_comment_idx').on(t.commentId, t.createdAt),
    projectIdx: index('comment_events_project_idx').on(t.projectId, t.createdAt),
  }),
);
