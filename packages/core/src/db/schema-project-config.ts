import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects, users } from './schema.js';

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
