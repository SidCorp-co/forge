// The builder rule kept beside each verdict (ISS-1070 r5, 0627): `verdict_builder_facts` holds
// whether a verdict is its issue's builder's, written only by `issues/builder-facts.ts`, and
// `issue_read_model_stale` the issues whose builder inputs moved since, marked by each input table's
// trigger inside the writing transaction (`forge_mark_issues_stale`).

import { bigint, boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { criterionVerdicts } from './schema-issue-criteria.js';
import { issues } from './schema-issues.js';

export const verdictBuilderFacts = pgTable(
  'verdict_builder_facts',
  {
    verdictId: uuid('verdict_id')
      .primaryKey()
      .references(() => criterionVerdicts.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    byBuilder: boolean('by_builder').notNull(),
    /** The status a run was declared over the issue at, where that is why its session reads as the
     *  builder (`built-by.ts:declaredBeforeLandingSql`); null otherwise. */
    declaredBeforeLanding: text('declared_before_landing'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('verdict_builder_facts_issue_idx').on(t.issueId),
  }),
);

export const issueReadModelStale = pgTable('issue_read_model_stale', {
  issueId: uuid('issue_id').primaryKey(),
  gen: bigint('gen', { mode: 'number' }).notNull().default(1),
  cause: text('cause').notNull(),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
});
