// Each issue's traced criteria kept per issue (ISS-1070 r7, 0633): `issue_criteria_facts` holds them
// as the standing reads them, written only by `requirements/criteria-facts.ts`, and
// `issue_criteria_facts_stale` the issues whose inputs moved since, marked by each input table's
// trigger inside the writing transaction (`forge_mark_criteria_facts_stale`).

import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues } from './schema-issues.js';

export const issueCriteriaFacts = pgTable(
  'issue_criteria_facts',
  {
    issueId: uuid('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** The issue's criteria as `requirements/standing-facts.ts:issueCriteriaOf` answers them, times as ISO strings. */
    criteria: jsonb('criteria').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    arrayChk: check('issue_criteria_facts_array_chk', sql`jsonb_typeof(${t.criteria}) = 'array'`),
  }),
);

export const issueCriteriaFactsStale = pgTable(
  'issue_criteria_facts_stale',
  {
    issueId: uuid('issue_id').primaryKey(),
    gen: bigint('gen', { mode: 'number' }).notNull().default(1),
    cause: text('cause').notNull(),
    markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    markedIdx: index('issue_criteria_facts_stale_marked_idx').on(t.markedAt, t.issueId),
  }),
);
