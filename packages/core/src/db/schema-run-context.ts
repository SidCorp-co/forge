import { RUN_CONTEXT_HOWS, RUN_CONTEXT_SOURCE_KINDS } from '@forge/contracts/run-context';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agentSessions } from './schema-agent-sessions.js';
import { users } from './schema-auth.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * Each rule, knowledge entry, lesson and memory that reached a run session (ISS-1065): composed into
 * its prompt or orientation, or returned by a knowledge get or a knowledge or memory search its
 * credential made. Owned by `run-context`; one row per reach, written in one batch per read and never
 * changed. A run over several issues records one row per issue, so an issue's read finds every reach.
 */
export const runContextReaches = pgTable(
  'run_context_reaches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentSessionId: uuid('agent_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    /** The issue the session worked when the source reached it; null for a session working none. */
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: RUN_CONTEXT_SOURCE_KINDS }).notNull(),
    /** A rule, knowledge or lesson slug, or a memory's id. */
    ref: text('ref').notNull(),
    /** `updatedAt` (a memory's `asOf`) where the read carried one, else `sha256:<16 hex>` of the text given. */
    revision: text('revision'),
    how: text('how', { enum: RUN_CONTEXT_HOWS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('run_context_reaches_session_idx').on(t.agentSessionId, t.createdAt),
    issueIdx: index('run_context_reaches_issue_idx').on(t.issueId, t.createdAt),
    projectIdx: index('run_context_reaches_project_idx').on(t.projectId),
    kindChk: check(
      'run_context_reaches_kind_chk',
      sql`${t.kind} IN (${inList(RUN_CONTEXT_SOURCE_KINDS)})`,
    ),
    howChk: check('run_context_reaches_how_chk', sql`${t.how} IN (${inList(RUN_CONTEXT_HOWS)})`),
  }),
);

/** Who asked a find that matched nothing: a person, or an agent's credential. */
export const FIND_MISS_ASKERS = ['person', 'agent'] as const;

/**
 * Each find that matched nothing (ISS-1256): the gap a missing term or rule leaves, kept so the find
 * door's gaps read can show it. Owned by `run-context`, beside what reached a session: a miss is the
 * read that reached nothing. One row per miss, written by `recordFindMiss` and never changed.
 */
export const findMisses = pgTable(
  'find_misses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    askedBy: text('asked_by', { enum: FIND_MISS_ASKERS }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('find_misses_project_idx').on(t.projectId, t.createdAt),
    queryChk: check('find_misses_query_chk', sql`length(${t.query}) BETWEEN 1 AND 200`),
    askedByChk: check(
      'find_misses_asked_by_chk',
      sql`${t.askedBy} IN (${inList(FIND_MISS_ASKERS)})`,
    ),
  }),
);
