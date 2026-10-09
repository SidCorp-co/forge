import { CRITERION_CLASSES, DESIGN_LIMITS } from '@forge/contracts/issue-design';
import { type SQL, sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues, projects, users } from './schema.js';
import { issueCriteria } from './schema-issue-criteria.js';
import { liveIssueLeasesSql } from './schema-issue-leases.js';

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

/** Which holders a scope read leaves out, and which it narrows to. */
export interface ScopeHoldersFilter {
  /** Canonical keys that are never holders: the issues the asker takes together in one run. */
  exceptKeys?: readonly string[];
  /** A run whose leases are never holders: the run that holds the asker. */
  exceptRunId?: string | null;
  /** Only holders whose work is at build, test or release: the first to build goes first. */
  buildingOnly?: boolean;
}

/** `modules` and every ancestor label of each, as a set: a design naming a group label claims
 *  its subtree. */
function moduleClosureSql(modules: SQL): SQL {
  return sql`
    WITH RECURSIVE up(id) AS (
      SELECT unnest(${modules})
      UNION
      SELECT lb.parent_id FROM labels lb JOIN up ON lb.id = up.id WHERE lb.parent_id IS NOT NULL
    )
    SELECT id FROM up`;
}

/**
 * The live runs holding an issue whose declared scope meets `issueId`'s (REQ-36 BC-5): one row per
 * held issue, with the modules and contracts the two designs share. Two designs meet on a module
 * both name or that one names above the other, and on a contract both name, in one project. An
 * issue with no design declares no scope, so it meets nothing, as asker or as holder: its scope is
 * asked when the design gate first requires one, at the move into build. The asker's own key is
 * never a holder of it: that is the lease's refusal. Held is `liveIssueLeasesSql`, so the scope and
 * the lease read one holder.
 */
export function scopeHoldersSql(issueId: SQL, filter: ScopeHoldersFilter = {}): SQL {
  const exceptKeys =
    filter.exceptKeys && filter.exceptKeys.length > 0
      ? sql`AND sc_l.issue_key NOT IN (${sql.join(
          filter.exceptKeys.map((k) => sql`${k}`),
          sql`, `,
        )})`
      : sql``;
  const exceptRun = filter.exceptRunId
    ? sql`AND sc_l.run_id IS DISTINCT FROM ${filter.exceptRunId}::uuid`
    : sql``;
  const building = filter.buildingOnly
    ? sql`AND EXISTS (SELECT 1 FROM issue_work_state sc_w
                       WHERE sc_w.issue_id = sc_hi.id AND sc_w.step IN ('build', 'test', 'release'))`
    : sql``;
  return sql`
    SELECT sc_hi.id AS holder_issue_id, sc_hi.iss_seq AS holder_seq, sc_l.run_id, sc_l.session_id,
           sc_l.device_id, sc_shared.modules, sc_shared.contracts
      FROM issue_designs sc_mine
      JOIN issues sc_mi ON sc_mi.id = sc_mine.issue_id
      JOIN ${liveIssueLeasesSql()} sc_l
        ON sc_l.project_id = sc_mine.project_id AND sc_l.issue_key <> 'ISS-' || sc_mi.iss_seq
      JOIN issues sc_hi ON sc_hi.project_id = sc_l.project_id AND 'ISS-' || sc_hi.iss_seq = sc_l.issue_key
      JOIN issue_designs sc_theirs ON sc_theirs.issue_id = sc_hi.id
      CROSS JOIN LATERAL (
        SELECT ARRAY(
                 SELECT DISTINCT m FROM unnest(sc_mine.modules || sc_theirs.modules) m
                  WHERE m IN (${moduleClosureSql(sql`sc_mine.modules`)})
                    AND m IN (${moduleClosureSql(sql`sc_theirs.modules`)})
               ) AS modules,
               ARRAY(
                 SELECT DISTINCT c FROM unnest(sc_mine.contracts) c WHERE c = ANY(sc_theirs.contracts)
               ) AS contracts
      ) sc_shared
     WHERE sc_mine.issue_id = ${issueId}
       AND (cardinality(sc_shared.modules) > 0 OR cardinality(sc_shared.contracts) > 0)
       ${exceptKeys}
       ${exceptRun}
       ${building}`;
}

/** Whether a live run holds an issue whose declared scope meets `issueId`'s: the one predicate the
 *  admissible list and the strand sweep withhold by, beside the named refusal every door throws. */
export function scopeHeldSql(issueId: SQL): SQL {
  return sql`EXISTS (${scopeHoldersSql(issueId)})`;
}
