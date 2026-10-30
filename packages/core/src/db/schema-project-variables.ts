import {
  VARIABLE_EVENT_ACTS,
  VARIABLE_PROPOSAL_ACTS,
  VARIABLE_PROPOSAL_STATUSES,
  VARIABLE_TYPES,
} from '@forge/contracts/variables';
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { issues } from './schema-issues.js';
import { projectSecrets } from './schema-project-config.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** The `project_secrets` scope a variable's value lives under: one store of secret values (REQ-80). */
export const VARIABLE_SECRET_SCOPE = 'var';

/**
 * A project's environment variable (REQ-80 BC-1, BC-2): a key at a scope (every environment, or one
 * the project document declares), its type and protected flag. Its value is never here: it is the
 * `project_secrets` row `(project_id, 'var', secret_name)`, encrypted by the same vault, and the
 * fingerprint is a keyed digest of it.
 */
export const projectVariables = pgTable(
  'project_variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    environment: text('environment'),
    type: text('type', { enum: VARIABLE_TYPES }).notNull(),
    protected: boolean('protected').notNull(),
    secretScope: text('secret_scope').notNull().default(VARIABLE_SECRET_SCOPE),
    secretName: text('secret_name').notNull(),
    fingerprint: text('fingerprint').notNull(),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyScopeUq: uniqueIndex('project_variables_key_scope_uq').on(
      t.projectId,
      t.key,
      sql`coalesce(${t.environment}, '')`,
    ),
    value: foreignKey({
      name: 'project_variables_value_fk',
      columns: [t.projectId, t.secretScope, t.secretName],
      foreignColumns: [projectSecrets.projectId, projectSecrets.scope, projectSecrets.name],
    }),
    typeChk: check('project_variables_type_chk', sql`${t.type} IN (${inList(VARIABLE_TYPES)})`),
    keyChk: check('project_variables_key_chk', sql`${t.key} ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'`),
    scopeChk: check('project_variables_secret_scope_chk', sql`${t.secretScope} = 'var'`),
    versionChk: check('project_variables_version_chk', sql`${t.version} >= 1`),
  }),
);

/**
 * A change an agent proposed on an issue (REQ-80 BC-6): it takes effect only when a holder of
 * env.manage approves it. A proposed value is held in the same store as a variable's, under its own
 * `secret_name`, and destroyed when the proposal is decided.
 */
export const projectVariableProposals = pgTable(
  'project_variable_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    act: text('act', { enum: VARIABLE_PROPOSAL_ACTS }).notNull(),
    key: text('key').notNull(),
    environment: text('environment'),
    type: text('type', { enum: VARIABLE_TYPES }),
    protected: boolean('protected'),
    secretName: text('secret_name'),
    fingerprint: text('fingerprint'),
    status: text('status', { enum: VARIABLE_PROPOSAL_STATUSES }).notNull().default('proposed'),
    reason: text('reason').notNull(),
    proposedBy: uuid('proposed_by').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decisionReason: text('decision_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    projectIdx: index('project_variable_proposals_project_idx').on(t.projectId, t.createdAt),
    actChk: check(
      'project_variable_proposals_act_chk',
      sql`${t.act} IN (${inList(VARIABLE_PROPOSAL_ACTS)})`,
    ),
    statusChk: check(
      'project_variable_proposals_status_chk',
      sql`${t.status} IN (${inList(VARIABLE_PROPOSAL_STATUSES)})`,
    ),
    decidedChk: check(
      'project_variable_proposals_decided_chk',
      sql`(${t.status} = 'proposed') = (${t.decidedAt} IS NULL)`,
    ),
  }),
);

/** Every act on a variable (REQ-80 BC-2): who, which credential, when, key, scope, fingerprints; never a value. */
export const projectVariableEvents = pgTable(
  'project_variable_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    variableId: uuid('variable_id'),
    act: text('act', { enum: VARIABLE_EVENT_ACTS }).notNull(),
    key: text('key').notNull(),
    environment: text('environment'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorTokenId: uuid('actor_token_id'),
    agency: text('agency'),
    oldFingerprint: text('old_fingerprint'),
    newFingerprint: text('new_fingerprint'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('project_variable_events_project_idx').on(t.projectId, t.at),
    actChk: check(
      'project_variable_events_act_chk',
      sql`${t.act} IN (${inList(VARIABLE_EVENT_ACTS)})`,
    ),
    agencyChk: check(
      'project_variable_events_agency_chk',
      sql`${t.agency} IS NULL OR ${t.agency} IN ('human', 'agent')`,
    ),
  }),
);
