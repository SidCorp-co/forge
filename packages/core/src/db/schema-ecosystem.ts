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

export const contractVersions = pgTable(
  'contract_versions',
  {
    providerProjectId: uuid('provider_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractSlug: text('contract_slug').notNull(),
    version: text('version').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.providerProjectId, t.contractSlug, t.version] }),
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
