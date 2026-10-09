import { CRITERION_CLASSES, DESIGN_LIMITS } from '@forge/contracts/issue-design';
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues, projects, users } from './schema.js';
import { issueCriteria } from './schema-issue-criteria.js';

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// An issue's design record (REQ-36 BC-1, BC-13; Issue lifecycle r15 `design-check`), written by the
// issue kernel (`issues/design-record.ts`) and replaced whole by each write, which bumps `revision`.
// `modules` holds the project's module label ids, `contracts` the `<project>/<contract>` it touches.
export const issueDesigns = pgTable(
  'issue_designs',
  {
    issueId: uuid('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    modules: uuid('modules').array().notNull(),
    contracts: text('contracts').array().notNull(),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recordedAgency: text('recorded_agency', { enum: ['human', 'agent'] }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('issue_designs_project_idx').on(t.projectId),
    revisionChk: check('issue_designs_revision_chk', sql`${t.revision} >= 1`),
    modulesChk: check(
      'issue_designs_modules_chk',
      sql`cardinality(${t.modules}) BETWEEN 1 AND ${sql.raw(String(DESIGN_LIMITS.modules))}`,
    ),
    contractsChk: check(
      'issue_designs_contracts_chk',
      sql`cardinality(${t.contracts}) <= ${sql.raw(String(DESIGN_LIMITS.contracts))}`,
    ),
    agencyChk: check(
      'issue_designs_agency_chk',
      sql`${t.recordedAgency} IS NULL OR ${t.recordedAgency} IN ('human', 'agent')`,
    ),
  }),
);

// One criterion's line of the design: its class, its pattern (null only where the project reads no
// catalog) and its proof plan. Keyed by the criterion row, so a reworded or retired criterion leaves
// the design without its line and the check names it.
export const issueDesignCriteria = pgTable(
  'issue_design_criteria',
  {
    criterionId: uuid('criterion_id')
      .primaryKey()
      .references(() => issueCriteria.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issueDesigns.issueId, { onDelete: 'cascade' }),
    criterionClass: text('criterion_class', { enum: CRITERION_CLASSES }).notNull(),
    pattern: text('pattern'),
    proof: text('proof').notNull(),
  },
  (t) => ({
    issueIdx: index('issue_design_criteria_issue_idx').on(t.issueId),
    classChk: check(
      'issue_design_criteria_class_chk',
      sql`${t.criterionClass} IN (${quoted(CRITERION_CLASSES)})`,
    ),
    patternChk: check(
      'issue_design_criteria_pattern_chk',
      sql`${t.pattern} IS NULL OR ${t.pattern} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`,
    ),
    proofChk: check(
      'issue_design_criteria_proof_chk',
      sql`length(${t.proof}) BETWEEN 1 AND ${sql.raw(String(DESIGN_LIMITS.proof))}`,
    ),
  }),
);

export type IssueDesignRow = typeof issueDesigns.$inferSelect;
export type IssueDesignCriterionRow = typeof issueDesignCriteria.$inferSelect;
