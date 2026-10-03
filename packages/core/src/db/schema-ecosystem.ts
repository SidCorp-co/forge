import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations, projects, users } from './schema.js';

export const ecosystems = pgTable(
  'ecosystems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    channelCode: text('channel_code').notNull(),
    stewardOrgId: uuid('steward_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUq: uniqueIndex('ecosystems_slug_uq').on(t.slug),
    channelCodeUq: uniqueIndex('ecosystems_channel_code_uq').on(t.channelCode),
    stewardIdx: index('ecosystems_steward_org_id_idx').on(t.stewardOrgId),
    revisionChk: check('ecosystems_revision_chk', sql`${t.revision} >= 1`),
  }),
);

export const ecosystemRevisions = pgTable(
  'ecosystem_revisions',
  {
    ecosystemId: uuid('ecosystem_id')
      .notNull()
      .references(() => ecosystems.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    writtenBy: uuid('written_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ecosystemId, t.revision] }),
    revisionChk: check('ecosystem_revisions_revision_chk', sql`${t.revision} >= 1`),
  }),
);

export const ecosystemMemberships = pgTable(
  'ecosystem_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ecosystemId: uuid('ecosystem_id')
      .notNull()
      .references(() => ecosystems.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedReason: text('ended_reason'),
  },
  (t) => ({
    openUq: uniqueIndex('ecosystem_memberships_open_uq')
      .on(t.ecosystemId, t.projectId)
      .where(sql`state IN ('invited', 'active')`),
    projectIdx: index('ecosystem_memberships_project_id_idx').on(t.projectId),
    stateChk: check(
      'ecosystem_memberships_state_chk',
      sql`${t.state} IN ('invited', 'active', 'declined', 'left', 'removed')`,
    ),
    decidedChk: check(
      'ecosystem_memberships_decided_chk',
      sql`(${t.state} = 'invited') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)`,
    ),
    endedChk: check(
      'ecosystem_memberships_ended_chk',
      sql`(${t.state} IN ('left', 'removed')) = (${t.endedAt} IS NOT NULL AND ${t.endedReason} IS NOT NULL AND length(${t.endedReason}) BETWEEN 1 AND 500)`,
    ),
  }),
);

export const ecosystemMembershipEvents = pgTable(
  'ecosystem_membership_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => ecosystemMemberships.id, { onDelete: 'cascade' }),
    verb: text('verb').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    membershipIdx: index('ecosystem_membership_events_membership_id_idx').on(t.membershipId),
    verbChk: check(
      'ecosystem_membership_events_verb_chk',
      sql`${t.verb} IN ('invite', 'accept', 'decline', 'leave', 'remove')`,
    ),
  }),
);

export const projectInterfaces = pgTable(
  'project_interfaces',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    revisionChk: check('project_interfaces_revision_chk', sql`${t.revision} >= 1`),
  }),
);

export const projectInterfaceRevisions = pgTable(
  'project_interface_revisions',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    writtenBy: uuid('written_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.revision] }),
    revisionChk: check('project_interface_revisions_revision_chk', sql`${t.revision} >= 1`),
  }),
);

export const ecosystemConsumptions = pgTable(
  'ecosystem_consumptions',
  {
    consumerProjectId: uuid('consumer_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    providerProjectId: uuid('provider_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractSlug: text('contract_slug').notNull(),
    ecosystemId: uuid('ecosystem_id')
      .notNull()
      .references(() => ecosystems.id, { onDelete: 'restrict' }),
    builtAgainst: text('built_against').notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.consumerProjectId, t.providerProjectId, t.contractSlug, t.ecosystemId],
    }),
    providerIdx: index('ecosystem_consumptions_provider_idx').on(t.providerProjectId),
    notSelfChk: check(
      'ecosystem_consumptions_not_self_chk',
      sql`${t.consumerProjectId} <> ${t.providerProjectId}`,
    ),
  }),
);

export const contractArtifacts = pgTable(
  'contract_artifacts',
  {
    sha256: text('sha256').primaryKey(),
    content: text('content').notNull(),
    byteLength: integer('byte_length').notNull(),
    storedAt: timestamp('stored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shaChk: check('contract_artifacts_sha256_chk', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  }),
);

export const contractVersions = pgTable(
  'contract_versions',
  {
    providerProjectId: uuid('provider_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractSlug: text('contract_slug').notNull(),
    version: text('version').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    contractType: text('contract_type').notNull(),
    document: jsonb('document').notNull(),
    classification: text('classification').notNull(),
    artifactSha256: text('artifact_sha256').references(() => contractArtifacts.sha256, {
      onDelete: 'restrict',
    }),
    elements: text('elements').array(),
    // cm:why a version is proposed when recorded and current only once approved; `decided_as` says whether a person or the project's own agent decided, and `before-approval` marks the versions recorded before the gate existed (migration 0348), which were current as recorded
    approval: text('approval').notNull().default('proposed'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAs: text('decided_as'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.providerProjectId, t.contractSlug, t.version] }),
    approvalChk: check(
      'contract_versions_approval_chk',
      sql`${t.approval} IN ('proposed', 'approved', 'returned')`,
    ),
    decidedChk: check(
      'contract_versions_decided_chk',
      sql`(${t.approval} = 'proposed') = (${t.decidedAt} IS NULL AND ${t.decidedAs} IS NULL)`,
    ),
    decidedAsChk: check(
      'contract_versions_decided_as_chk',
      sql`${t.decidedAs} IS NULL OR (${t.decidedAs} IN ('person', 'agent') AND ${t.decidedBy} IS NOT NULL) OR (${t.decidedAs} = 'before-approval' AND ${t.decidedBy} IS NULL)`,
    ),
    returnedChk: check(
      'contract_versions_returned_chk',
      sql`${t.approval} <> 'returned' OR (${t.decisionReason} IS NOT NULL AND length(${t.decisionReason}) BETWEEN 1 AND 2000)`,
    ),
    latestIdx: index('contract_versions_latest_idx').on(
      t.providerProjectId,
      t.contractSlug,
      t.recordedAt,
    ),
    classificationChk: check(
      'contract_versions_classification_chk',
      sql`${t.classification} IN ('breaking', 'non-breaking', 'unknown', 'initial')`,
    ),
  }),
);

export const contractMeasurements = pgTable(
  'contract_measurements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerProjectId: uuid('provider_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractSlug: text('contract_slug').notNull(),
    commitSha: text('commit_sha').notNull(),
    branch: text('branch').notNull(),
    environments: text('environments').array().notNull(),
    outcome: text('outcome').notNull(),
    version: text('version'),
    reason: text('reason'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    landUq: uniqueIndex('contract_measurements_land_uq').on(
      t.providerProjectId,
      t.contractSlug,
      t.commitSha,
    ),
    outcomeChk: check(
      'contract_measurements_outcome_chk',
      sql`${t.outcome} IN ('pending', 'recorded', 'unchanged', 'stale', 'refused')`,
    ),
    commitChk: check('contract_measurements_commit_chk', sql`${t.commitSha} ~ '^[0-9a-f]{40}$'`),
    settledChk: check(
      'contract_measurements_settled_chk',
      sql`(${t.outcome} = 'pending') = (${t.settledAt} IS NULL)`,
    ),
    reasonChk: check(
      'contract_measurements_reason_chk',
      sql`${t.outcome} NOT IN ('refused', 'stale') OR ${t.reason} IS NOT NULL`,
    ),
    versionChk: check(
      'contract_measurements_version_chk',
      sql`(${t.outcome} = 'recorded') = (${t.version} IS NOT NULL)`,
    ),
  }),
);

export const channelCounters = pgTable(
  'channel_counters',
  {
    ecosystemId: uuid('ecosystem_id')
      .notNull()
      .references(() => ecosystems.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    lastNumber: integer('last_number').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ecosystemId, t.type] }),
    typeChk: check(
      'channel_counters_type_chk',
      sql`${t.type} IN ('change-notice', 'acknowledgement', 'rfi', 'change-request', 'decision')`,
    ),
    lastNumberChk: check('channel_counters_last_number_chk', sql`${t.lastNumber} >= 1`),
  }),
);

const DOCUMENT_TYPE_SQL = sql.raw(
  `('change-notice', 'acknowledgement', 'rfi', 'change-request', 'decision')`,
);

export const channelDocuments = pgTable(
  'channel_documents',
  {
    id: uuid('id').primaryKey(),
    ecosystemId: uuid('ecosystem_id')
      .notNull()
      .references(() => ecosystems.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    fromProjectId: uuid('from_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    toProjectIds: uuid('to_project_ids').array().notNull(),
    number: text('number'),
    state: text('state').notNull(),
    inReplyTo: text('in_reply_to'),
    thread: text('thread'),
    authorKind: text('author_kind').notNull(),
    authorId: text('author_id').notNull(),
    authorVia: text('author_via').notNull(),
    document: jsonb('document').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => ({
    numberUq: uniqueIndex('channel_documents_number_uq').on(t.number),
    ecosystemStateIdx: index('channel_documents_ecosystem_state_idx').on(t.ecosystemId, t.state),
    fromIdx: index('channel_documents_from_project_id_idx').on(t.fromProjectId),
    toIdx: index('channel_documents_to_project_ids_idx').using('gin', t.toProjectIds),
    threadIdx: index('channel_documents_thread_idx').on(t.thread),
    typeChk: check('channel_documents_type_chk', sql`${t.type} IN ${DOCUMENT_TYPE_SQL}`),
    stateChk: check(
      'channel_documents_state_chk',
      sql`${t.state} IN ('draft', 'submitted', 'returned', 'published')`,
    ),
    numberedChk: check(
      'channel_documents_numbered_chk',
      sql`${t.state} = 'draft' OR ${t.number} IS NOT NULL`,
    ),
    publishedChk: check(
      'channel_documents_published_chk',
      sql`(${t.state} = 'published') = (${t.publishedAt} IS NOT NULL)`,
    ),
    authorChk: check(
      'channel_documents_author_chk',
      sql`(${t.authorKind} = 'agent' AND ${t.authorVia} = 'master') OR (${t.authorKind} = 'person' AND ${t.authorVia} IN ('assistant', 'web', 'cli'))`,
    ),
  }),
);

export const channelDocumentEvents = pgTable(
  'channel_document_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => channelDocuments.id, { onDelete: 'restrict' }),
    verb: text('verb').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    actorVia: text('actor_via').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    supersededBy: text('superseded_by'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    documentIdx: index('channel_document_events_document_id_idx').on(t.documentId),
    endsOnceUq: uniqueIndex('channel_document_events_ends_once_uq')
      .on(t.documentId)
      .where(sql`verb IN ('withdraw', 'supersede')`),
    verbChk: check(
      'channel_document_events_verb_chk',
      sql`${t.verb} IN ('draft', 'edit', 'submit', 'approve', 'return', 'publish', 'withdraw', 'supersede')`,
    ),
    endChk: check(
      'channel_document_events_end_chk',
      sql`(${t.verb} NOT IN ('withdraw', 'supersede') OR (${t.reason} IS NOT NULL AND length(${t.reason}) BETWEEN 1 AND 500)) AND ((${t.verb} = 'supersede') = (${t.supersededBy} IS NOT NULL))`,
    ),
  }),
);

export const channelThreadHolds = pgTable(
  'channel_thread_holds',
  {
    id: uuid('id').primaryKey(),
    ecosystemId: uuid('ecosystem_id')
      .notNull()
      .references(() => ecosystems.id, { onDelete: 'restrict' }),
    thread: text('thread').notNull(),
    action: text('action').notNull(),
    byKind: text('by_kind').notNull(),
    byId: text('by_id').notNull(),
    byVia: text('by_via').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sideProjectId: uuid('side_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index('channel_thread_holds_thread_idx').on(t.thread, t.at),
    actionChk: check('channel_thread_holds_action_chk', sql`${t.action} IN ('hold', 'release')`),
    personChk: check(
      'channel_thread_holds_person_chk',
      sql`${t.byKind} = 'person' AND ${t.byVia} IN ('assistant', 'web', 'cli')`,
    ),
    reasonChk: check(
      'channel_thread_holds_reason_chk',
      sql`${t.action} <> 'hold' OR (${t.reason} IS NOT NULL AND length(${t.reason}) BETWEEN 1 AND 1000)`,
    ),
  }),
);
