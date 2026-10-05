import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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
import * as axes from './release-axes.js';
import { users } from './schema-auth.js';
import { integrationConnections, integrationDeliveries } from './schema-integrations.js';
import { projects } from './schema-projects.js';

export const integrationBindings = pgTable(
  'integration_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Denormalized from the connection so the inbound router + unique index work
    // without a join. Always equals the parent connection's provider.
    provider: text('provider').notNull(),
    role: text('role', { enum: axes.bindingRoles }).notNull(),
    // Per-binding overrides (e.g. coolify `targets[]` deploy apps). Overlaid on
    // top of connection.config at dispatch time.
    config: jsonb('config').notNull().default({}),
    // Per-binding HMAC secret for inbound webhook signature verification — an
    // inbound webhook is project+env scoped, so this stays on the binding.
    integrationSecret: text('integration_secret'),
    // ISS-558 — multi-store support for epodsystem. Empty string = the default
    // (unlabeled) binding; a non-empty kebab slug = a named extra binding.
    // Non-epodsystem providers always leave this as '' (the DB default), so
    // `integration_bindings_service_uq` still keeps one service binding per
    // (project, provider) for sentry/rocketchat/github.
    label: text('label').notNull().default(''),
    active: boolean('active').notNull().default(true),
    agentAccess: text('agent_access', { enum: axes.agentAccessValues }).notNull().default('none'),
    instructions: text('instructions'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connectionIdx: index('integration_bindings_connection_idx').on(t.connectionId),
    projectProviderIdx: index('integration_bindings_project_provider_idx').on(
      t.projectId,
      t.provider,
    ),
    serviceUq: uniqueIndex('integration_bindings_service_uq')
      .on(t.projectId, t.provider, t.label)
      .where(axes.SERVICE_ROLE_PRED),
    ...axes.bindingShapeChecks,
  }),
);

export const integrationBindingsRelations = relations(integrationBindings, ({ one, many }) => ({
  connection: one(integrationConnections, {
    fields: [integrationBindings.connectionId],
    references: [integrationConnections.id],
  }),
  project: one(projects, {
    fields: [integrationBindings.projectId],
    references: [projects.id],
  }),
  deliveries: many(integrationDeliveries),
}));

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const projectConfigDocuments = pgTable(
  'project_config_documents',
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
    revisionPositiveChk: check('project_config_documents_revision_chk', sql`${t.revision} >= 1`),
  }),
);

export const projectConfigRevisions = pgTable(
  'project_config_revisions',
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
    revisionPositiveChk: check('project_config_revisions_revision_chk', sql`${t.revision} >= 1`),
  }),
);

export const projectPolicies = pgTable(
  'project_policies',
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
    revisionPositiveChk: check('project_policies_revision_chk', sql`${t.revision} >= 1`),
  }),
);

export const projectTestingProfiles = pgTable(
  'project_testing_profiles',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    profileId: text('profile_id').notNull(),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.profileId] }),
    revisionPositiveChk: check('project_testing_profiles_revision_chk', sql`${t.revision} >= 1`),
    profileIdChk: check(
      'project_testing_profiles_profile_id_chk',
      sql`${t.profileId} ~ '^[a-z][a-z0-9-]{0,62}$'`,
    ),
  }),
);

export const projectSecrets = pgTable(
  'project_secrets',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    name: text('name').notNull(),
    valueEnc: bytea('value_enc').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.scope, t.name] }),
    scopeChk: check('project_secrets_scope_chk', sql`${t.scope} ~ '^[a-z][a-z0-9-]{0,62}$'`),
    nameChk: check('project_secrets_name_chk', sql`${t.name} ~ '^[a-z][a-z0-9-]{0,62}$'`),
  }),
);
