// A testing-secrets read by a judge run declared at a requirement (0608, ISS-975).

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { issues } from './schema-issues.js';
import { requirements } from './schema-requirements.js';

/** How a requirement judge's environment was named: a delivering issue's landing, `delivery.judgedOn`, or production. */
export const REQUIREMENT_SECRET_READ_BASES = ['landing', 'judgedOn', 'production'] as const;
export type RequirementSecretReadBasis = (typeof REQUIREMENT_SECRET_READ_BASES)[number];

/**
 * A testing-secrets read by a judge run declared at a requirement rather than an issue (ISS-975): the
 * read is audited on the requirement it judges, as a run over an issue's is on that issue's activity.
 * Insert-only. It names refs, never values, and is what the scrubber reads to know which values the
 * run's session holds (`requirementSecretRefsOfSession`).
 */
export const requirementSecretReads = pgTable(
  'requirement_secret_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
    /** The run's session and core's run id; kept past either, as an issue's activity keeps them. */
    sessionId: uuid('session_id').notNull(),
    runId: uuid('run_id').notNull(),
    /** The run id the box declared it under, where it declared one. */
    boxRunId: text('box_run_id'),
    /** The box that declared the run, and the person its credential acts for. */
    deviceId: uuid('device_id').notNull(),
    declaredBy: uuid('declared_by').references(() => users.id, { onDelete: 'set null' }),
    /** The delivering issue whose landing named the environment; null where `basis` is no landing. */
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    basis: text('basis', { enum: REQUIREMENT_SECRET_READ_BASES }).notNull(),
    environment: text('environment').notNull(),
    profile: text('profile').notNull(),
    refs: text('refs').array().notNull(),
    tokenId: uuid('token_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    basisChk: check(
      'requirement_secret_reads_basis_chk',
      sql`${t.basis} IN ('landing', 'judgedOn', 'production')`,
    ),
    requirementIdx: index('requirement_secret_reads_requirement_idx').on(
      t.requirementId,
      t.createdAt,
    ),
    sessionIdx: index('requirement_secret_reads_session_idx').on(t.sessionId),
  }),
);
