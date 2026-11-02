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
import { agentSessions } from './schema-agent-sessions.js';
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
    /**
     * The release it was judged on, as its project recorded it shipped (0583, ISS-900): on a project
     * whose production names no commit it serves, a verdict names the version instead of a commit.
     */
    releaseVersion: text('release_version'),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorDeviceId: uuid('author_device_id'),
    authorAgency: text('author_agency', { enum: actorAgencies }).notNull(),
    /** The run session that recorded it: the `run` the call named (0566); null where it named none. */
    runSessionId: uuid('run_session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),
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
    releaseChk: check(
      'requirement_criterion_verdicts_release_chk',
      sql`${t.releaseVersion} IS NULL OR ${t.releaseVersion} ~ '^[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}(-[a-z][a-z0-9]{0,15}\\.[0-9]{1,9})?$'`,
    ),
    // a judgement names exactly one of the commit or the release it was judged on; a skip neither
    judgedChk: check(
      'requirement_criterion_verdicts_judged_chk',
      sql`(${t.verdict} = 'skipped' AND ${t.commitSha} IS NULL AND ${t.releaseVersion} IS NULL) OR (${t.verdict} <> 'skipped' AND (${t.commitSha} IS NULL) <> (${t.releaseVersion} IS NULL) AND cardinality(${t.evidence}) > 0)`,
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
