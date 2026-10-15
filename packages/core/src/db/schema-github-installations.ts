import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import * as ints from './schema-integration-types.js';
import { integrationConnections } from './schema-integrations.js';
import { organizations } from './schema-orgs.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * An installation of the instance's GitHub App, recorded for the Forge org whose admin installed
 * it. Only a recorded installation is listed, suggested or bound for that org; GitHub's own list
 * of the App's installations is never read as a grant.
 */
export const githubAppInstallations = pgTable(
  'github_app_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type', { enum: ints.githubAccountTypes }).notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    proof: text('proof', { enum: ints.githubInstallationProofs }).notNull(),
    state: text('state', { enum: ints.githubInstallationStates }).notNull().default('active'),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }),
    /** `owner/repo` names GitHub said were taken off the installation, so their bindings read why. */
    removedRepositories: jsonb('removed_repositories').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connectionInstallationUq: uniqueIndex('github_app_installations_connection_installation_uq').on(
      t.connectionId,
      t.installationId,
    ),
    orgIdx: index('github_app_installations_org_idx').on(t.orgId),
    accountTypeChk: check(
      'github_app_installations_account_type_chk',
      sql`${t.accountType} IN (${inList(ints.githubAccountTypes)})`,
    ),
    proofChk: check(
      'github_app_installations_proof_chk',
      sql`${t.proof} IN (${inList(ints.githubInstallationProofs)})`,
    ),
    stateChk: check(
      'github_app_installations_state_chk',
      sql`${t.state} IN (${inList(ints.githubInstallationStates)})`,
    ),
  }),
);

export type GithubAppInstallationRow = typeof githubAppInstallations.$inferSelect;
