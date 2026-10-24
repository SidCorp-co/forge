// A business criterion judged on the running build at the requirement itself (0525, ISS-588).

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { requirementCriteria, requirements } from './schema-requirements.js';
import { actorAgencies } from './schema-vocabulary.js';

/**
 * A business criterion judged on the running build at the requirement itself (0525, ISS-588): the
 * proof of a requirement whose capability already shipped, which no issue carries (REQ-45 r3 BC-8).
 * Insert-only, one row per judgement of one wording (`requirement_criteria.id`); coverage reads it
 * beside the verdicts on issue criteria (`requirements/standing-coverage.ts`).
 */
export const requirementCriterionVerdicts = pgTable(
  'requirement_criterion_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'cascade' }),
    requirementCriterionId: uuid('requirement_criterion_id')
      .notNull()
      .references((): AnyPgColumn => requirementCriteria.id, { onDelete: 'cascade' }),
    verdict: text('verdict', { enum: ['pass', 'short', 'fail', 'skipped'] }).notNull(),
    reason: text('reason'),
    evidence: text('evidence').array().notNull().default(sql`'{}'::text[]`),
    commitSha: text('commit_sha'),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorDeviceId: uuid('author_device_id'),
    authorAgency: text('author_agency', { enum: actorAgencies }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    verdictChk: check(
      'requirement_criterion_verdicts_verdict_chk',
      sql`${t.verdict} IN ('pass', 'short', 'fail', 'skipped')`,
    ),
    agencyChk: check(
      'requirement_criterion_verdicts_agency_chk',
      sql`${t.authorAgency} IN ('human', 'agent')`,
    ),
    commitChk: check(
      'requirement_criterion_verdicts_commit_chk',
      sql`${t.commitSha} IS NULL OR ${t.commitSha} ~ '^[0-9a-f]{40}$'`,
    ),
    judgedChk: check(
      'requirement_criterion_verdicts_judged_chk',
      sql`${t.verdict} = 'skipped' OR (${t.commitSha} IS NOT NULL AND cardinality(${t.evidence}) > 0)`,
    ),
    skippedReasonChk: check(
      'requirement_criterion_verdicts_skipped_reason_chk',
      sql`${t.verdict} <> 'skipped' OR coalesce(${t.reason}, '') ~ '[^[:space:]]'`,
    ),
    requirementIdx: index('requirement_criterion_verdicts_requirement_idx').on(
      t.requirementId,
      t.createdAt.desc(),
    ),
  }),
);
