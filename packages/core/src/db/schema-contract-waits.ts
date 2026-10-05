import { CONTRACT_WAIT_LIMITS } from '@forge/contracts/contract-waits';
import { type SQL, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { issues, projects, users } from './schema.js';
import { contractVersions } from './schema-ecosystem.js';

// An issue waits on `contract >= version`, never on an issue in another project (REQ-9 BC-1, E1);
// the provider may be the issue's own project, where the contract is written first. Settled is stored
// because an approved version is never unapproved, so once true it stays true; the stamp is written
// in the transaction that approves the version. `issue_contract_wait_guard()` (0407) refuses a write
// that re-aims, unsettles or unretracts a row.
export const issueContractWaits = pgTable(
  'issue_contract_waits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    providerProjectId: uuid('provider_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractSlug: text('contract_slug').notNull(),
    minVersion: text('min_version').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledVersion: text('settled_version'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    retractedBy: uuid('retracted_by').references(() => users.id, { onDelete: 'restrict' }),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    retractReason: text('retract_reason'),
  },
  (t) => ({
    liveUq: uniqueIndex('issue_contract_waits_live_uq')
      .on(t.issueId, t.providerProjectId, t.contractSlug)
      .where(sql`retracted_at IS NULL`),
    issueIdx: index('issue_contract_waits_issue_idx').on(t.issueId),
    openIdx: index('issue_contract_waits_open_idx')
      .on(t.providerProjectId, t.contractSlug)
      .where(sql`retracted_at IS NULL AND settled_at IS NULL`),
    settledFk: foreignKey({
      name: 'issue_contract_waits_settled_version_fk',
      columns: [t.providerProjectId, t.contractSlug, t.settledVersion],
      foreignColumns: [
        contractVersions.providerProjectId,
        contractVersions.contractSlug,
        contractVersions.version,
      ],
    }).onDelete('restrict'),
    versionChk: check(
      'issue_contract_waits_version_chk',
      sql`length(${t.minVersion}) BETWEEN 1 AND ${sql.raw(String(CONTRACT_WAIT_LIMITS.version))}`,
    ),
    reasonChk: check(
      'issue_contract_waits_reason_chk',
      sql`${t.reason} IS NULL OR length(${t.reason}) BETWEEN 1 AND ${sql.raw(String(CONTRACT_WAIT_LIMITS.reason))}`,
    ),
    settledChk: check(
      'issue_contract_waits_settled_chk',
      sql`(${t.settledVersion} IS NULL) = (${t.settledAt} IS NULL)`,
    ),
    retractedChk: check(
      'issue_contract_waits_retracted_chk',
      sql`(${t.retractedAt} IS NULL) = (${t.retractedBy} IS NULL) AND (${t.retractedAt} IS NULL) = (${t.retractReason} IS NULL)`,
    ),
  }),
);

/** A live wait no approved version has settled holds its issue out of dispatch: the one predicate every door reads. */
export function contractWaitUnsettledSql(issueId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM issue_contract_waits cw
    WHERE cw.issue_id = ${issueId}
      AND cw.retracted_at IS NULL
      AND cw.settled_at IS NULL
  )`;
}
