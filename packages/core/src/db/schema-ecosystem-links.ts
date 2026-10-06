import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { contractVersions, ecosystems } from './schema-ecosystem.js';
import { projects } from './schema-projects.js';

export const ecosystemLinks = pgTable(
  'ecosystem_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // null is an in-project link, a module of a project calling that project's own contract; every cross-project link names the ecosystem it was made in (`ecosystem_links_scope_chk`)
    ecosystemId: uuid('ecosystem_id').references(() => ecosystems.id, { onDelete: 'restrict' }),
    consumerProjectId: uuid('consumer_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    modulePath: text('module_path').notNull(),
    providerProjectId: uuid('provider_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractSlug: text('contract_slug').notNull(),
    pinnedVersion: text('pinned_version').notNull(),
    state: text('state').notNull(),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    writtenByUser: uuid('written_by_user')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identityUq: uniqueIndex('ecosystem_links_identity_uq').on(
      t.consumerProjectId,
      t.modulePath,
      t.providerProjectId,
      t.contractSlug,
    ),
    ecosystemIdx: index('ecosystem_links_ecosystem_id_idx').on(t.ecosystemId),
    providerIdx: index('ecosystem_links_provider_idx').on(t.providerProjectId, t.contractSlug),
    pinnedFk: foreignKey({
      name: 'ecosystem_links_pinned_version_fk',
      columns: [t.providerProjectId, t.contractSlug, t.pinnedVersion],
      foreignColumns: [
        contractVersions.providerProjectId,
        contractVersions.contractSlug,
        contractVersions.version,
      ],
    }).onDelete('restrict'),
    scopeChk: check(
      'ecosystem_links_scope_chk',
      sql`(${t.consumerProjectId} <> ${t.providerProjectId}) = (${t.ecosystemId} IS NOT NULL)`,
    ),
    stateChk: check(
      'ecosystem_links_state_chk',
      sql`${t.state} IN ('building', 'current', 'behind', 'breaking', 'unverified')`,
    ),
    revisionChk: check('ecosystem_links_revision_chk', sql`${t.revision} >= 1`),
  }),
);

export const ecosystemBuilderRuns = pgTable(
  'ecosystem_builder_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ecosystemId: uuid('ecosystem_id')
      .notNull()
      .references(() => ecosystems.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    triggerSha: text('trigger_sha'),
    revision: integer('revision').notNull(),
    document: jsonb('document').notNull(),
    writtenByUser: uuid('written_by_user')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('ecosystem_builder_runs_project_idx').on(t.projectId, t.createdAt),
    ecosystemIdx: index('ecosystem_builder_runs_ecosystem_id_idx').on(t.ecosystemId),
    triggerChk: check(
      'ecosystem_builder_runs_trigger_chk',
      sql`${t.trigger} IN ('joined', 'push', 'manual')`,
    ),
    shaChk: check(
      'ecosystem_builder_runs_sha_chk',
      sql`${t.triggerSha} IS NULL OR ${t.triggerSha} ~ '^[0-9a-f]{40}$'`,
    ),
    revisionChk: check('ecosystem_builder_runs_revision_chk', sql`${t.revision} >= 1`),
  }),
);
