import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { channelDocuments, contractVersions } from './schema-ecosystem.js';
import { requirements } from './schema-requirements.js';

// cm:why dbLegacy (ISS-214): the contract waits and requests code is deleted and these tables wait for the one migration that drops them; the CHECK values they were created with are kept here so the schema still describes them
const CONTRACT_WAIT_AGENCIES = ['human', 'agent'] as const;
const CONTRACT_WAIT_LIMITS = { version: 40, reason: 1000 } as const;

const agencies = sql.raw(CONTRACT_WAIT_AGENCIES.map((a) => `'${a}'`).join(', '));

// cm:why a change request published to its provider lands as that provider's draft requirement (E2);
// the row is the pairing, insert-only by `contract_request_guard()`, so either side reads the other
export const contractRequests = pgTable(
  'contract_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    providerProjectId: uuid('provider_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractSlug: text('contract_slug').notNull(),
    channelDocumentId: uuid('channel_document_id')
      .notNull()
      .references(() => channelDocuments.id, { onDelete: 'restrict' }),
    requirementId: uuid('requirement_id')
      .notNull()
      .references((): AnyPgColumn => requirements.id, { onDelete: 'no action' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requestedAgency: text('requested_agency', { enum: CONTRACT_WAIT_AGENCIES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    documentUq: uniqueIndex('contract_requests_document_uq').on(t.channelDocumentId),
    requirementUq: uniqueIndex('contract_requests_requirement_uq').on(t.requirementId),
    projectIdx: index('contract_requests_project_idx').on(t.projectId, t.createdAt),
    providerIdx: index('contract_requests_provider_idx').on(t.providerProjectId, t.createdAt),
    notSelfChk: check(
      'contract_requests_not_self_chk',
      sql`${t.projectId} <> ${t.providerProjectId}`,
    ),
    agencyChk: check('contract_requests_agency_chk', sql`${t.requestedAgency} IN (${agencies})`),
  }),
);

// cm:why an issue waits on `contract >= version` of another project, never on an issue there (E1);
// settled is stored because an approved version is never unapproved, so once true it stays true,
// and `issue_contract_wait_guard()` refuses any write that would unsettle, unretract or re-aim a row
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
    contractRequestId: uuid('contract_request_id').references(() => contractRequests.id, {
      onDelete: 'no action',
    }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAgency: text('created_agency', { enum: CONTRACT_WAIT_AGENCIES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledVersion: text('settled_version'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    retractedBy: uuid('retracted_by').references(() => users.id, { onDelete: 'restrict' }),
    retractedAgency: text('retracted_agency', { enum: CONTRACT_WAIT_AGENCIES }),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    retractReason: text('retract_reason'),
  },
  (t) => ({
    liveUq: uniqueIndex('issue_contract_waits_live_uq')
      .on(t.issueId, t.providerProjectId, t.contractSlug)
      .where(sql`retracted_at IS NULL`),
    issueIdx: index('issue_contract_waits_project_issue_idx').on(t.projectId, t.issueId),
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
    notSelfChk: check(
      'issue_contract_waits_not_self_chk',
      sql`${t.projectId} <> ${t.providerProjectId}`,
    ),
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
      sql`(${t.retractedAt} IS NULL) = (${t.retractedBy} IS NULL) AND (${t.retractedAt} IS NULL) = (${t.retractedAgency} IS NULL) AND (${t.retractedAt} IS NULL) = (${t.retractReason} IS NULL)`,
    ),
    agencyChk: check(
      'issue_contract_waits_agency_chk',
      sql`${t.createdAgency} IN (${agencies}) AND (${t.retractedAgency} IS NULL OR ${t.retractedAgency} IN (${agencies}))`,
    ),
  }),
);
