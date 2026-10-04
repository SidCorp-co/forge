import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import { JOB_STATUSES } from '@forge/contracts/job-machine';
import { PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { RUNNER_PROVISION_STATUSES, RUNNER_STATUSES } from '@forge/contracts/runner-machine';
import { type InferSelectModel, isNull, relations, type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { canonicalUuidText, orgHandleText } from './column-checks.js';
import { devicePlatforms, deviceStatuses } from './device-vocabulary.js';
import { jobEventKinds } from './job-event-kinds.js';
import {
  agentSessionFailureReasons,
  agentSessionKinds,
  agentSessionStatuses,
  sessionRuntimeStates,
} from './session-vocabulary.js';
import { skillActivityEventTypes, skillActivityTriggers } from './skill-activity-vocabulary.js';

export {
  type AgentSessionFailureReason,
  type AgentSessionKind,
  type AgentSessionStatus,
  agentSessionFailureReasons,
  agentSessionKinds,
  agentSessionStatuses,
  type SessionRuntimeState,
  sessionRuntimeStates,
  terminalAgentSessionStatuses,
} from './session-vocabulary.js';
export {
  type SkillActivityEventType,
  type SkillActivityTrigger,
  skillActivityEventTypes,
  skillActivityTriggers,
} from './skill-activity-vocabulary.js';

import * as axes from './release-axes.js';
import { identSearchColumn, MEMORY_EMBEDDING_DIM, pgVector, tsVector } from './schema-types.js';

export { MEMORY_EMBEDDING_DIM, pgVector, tsVector } from './schema-types.js';

import type { DecisionFields } from '@forge/contracts/comments';
import { MACHINE_ENTITIES } from '@forge/contracts/machines';
import { MASTER_JOB_PANES_MAX } from '@forge/contracts/master-standing';
import { COMMENT_INTENTS } from '@forge/contracts/record-events';
import type { ReleaseNotes } from '@forge/contracts/release-notes';
import { SCHEDULE_KINDS } from '@forge/contracts/schedules';
import { BODY_FORMATS } from '../body/formats.js';
import type { IssueBranchOverride } from '../branches/resolve.js';
import { activityLog, actorAgencies } from './schema-activity.js';
import { feedback } from './schema-feedback.js';
import { requirementRevisions, requirements } from './schema-requirements.js';
import { scheduleRuns } from './schema-schedule-runs.js';
import { suggestions } from './schema-suggestions.js';
import { projectWorkflows } from './schema-workflows.js';

export {
  type ActorType,
  activityLog,
  activityLogRelations,
  actorAgencies,
  actorTypes,
} from './schema-activity.js';

export const userKinds = ['human', 'agent'] as const;
export type UserKind = (typeof userKinds)[number];

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  kind: text('kind', { enum: userKinds }).notNull().default('human'),
  /**
   * The label a person reads, and NOTHING else (ISS-1003).
   *
   * Free text, accented, changeable, not unique — a person sets their own and
   * an org admin sets an agent's. An agent account is minted carrying its
   * handle here; a person's is null until they type one, which is what every
   * renderer's "or the email address" branch is for.
   */
  displayName: text('display_name'),
  /**
   * Nullable since 0037: OAuth-only users have no local password. `/auth/local`
   * rejects a null hash, so a password-less account cannot be brute-forced
   * through the email/password endpoint.
   */
  passwordHash: text('password_hash'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  /**
   * Last `POST /api/auth/reauth`. Drives `requireFreshAuth()`; null for a user
   * who never re-authed, which reads as stale and forces a prompt (0065).
   */
  lastFreshAuthAt: timestamp('last_fresh_auth_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerAccountUq: uniqueIndex('oauth_accounts_provider_account_uniq').on(
      t.provider,
      t.providerAccountId,
    ),
    userIdIdx: index('oauth_accounts_user_id_idx').on(t.userId),
  }),
);

export const deviceLoginCodes = pgTable(
  'device_login_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull().unique(),
    deviceLabel: text('device_label').notNull(),
    devicePlatform: text('device_platform').notNull(),
    deviceHostname: text('device_hostname'),
    /** sha256 of `/etc/machine-id`, carried init→approve→issue so browser-approve dedups by machine like the paste-code flow. */
    machineId: text('machine_id'),
    createdIp: text('created_ip'),
    createdUserAgent: text('created_user_agent'),
    approvedUserId: uuid('approved_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    agentUserId: uuid('agent_user_id').references(() => users.id, { onDelete: 'cascade' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    grantEpoch: integer('grant_epoch').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('device_login_codes_expires_idx').on(t.expiresAt),
    consumedIdx: index('device_login_codes_consumed_idx').on(t.consumedAt),
  }),
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    token: text('token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('email_verification_tokens_user_id_idx').on(t.userId),
  }),
);

/** How a person wants the assistant to answer them, on every surface (ISS-1034). */
export const answerStyles = ['default', 'concise', 'detailed', 'bullets'] as const;
export type AnswerStyle = (typeof answerStyles)[number];

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull().default('system'),
  language: text('language').notNull().default('en'),
  /**
   * False suppresses in-app `mention` deliveries (gated in `notifications/deliver.ts#wantsDelivery`,
   * ISS-1063: the record is the system's account of what happened and stands either way).
   * `mention` is the only user-initiated type produced, so it is the only opt-out
   * offered — no controls for channels that do not exist.
   */
  notifyOnMention: boolean('notify_on_mention').notNull().default(true),
  /**
   * The org being "worked in" (ISS-469). Null means no explicit choice and the
   * client resolves it to the personal org; `set null` on org delete so a removed
   * org clears the pointer rather than blocking the delete or dangling.
   */
  activeOrgId: uuid('active_org_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
  /**
   * How the assistant answers this person, read on every turn for the linked
   * speaker whichever door they came through (ISS-1034). Per person, never per
   * room or per project.
   */
  answerStyle: text('answer_style', { enum: answerStyles }).notNull().default('default'),
  /** Free text the person wants every reply to honour — what to always include, never repeat. */
  assistantInstructions: text('assistant_instructions'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdUsedAtIdx: index('refresh_tokens_user_id_used_at_idx').on(t.userId, t.usedAt),
    tokenPrefixIdx: index('refresh_tokens_token_prefix_idx').on(t.tokenPrefix),
  }),
);

export const orgMemberRoles = ['owner', 'admin', 'member'] as const;
export type OrgMemberRole = (typeof orgMemberRoles)[number];

export const memberLenses = ['technical', 'product'] as const;
export type MemberLens = (typeof memberLenses)[number];

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    isPersonal: boolean('is_personal').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    personalOwnerUq: uniqueIndex('organizations_personal_owner_uq')
      .on(t.createdBy)
      .where(sql`is_personal = true`),
  }),
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: orgMemberRoles }).notNull().default('member'),
    lenses: text('lenses').array().notNull().default(sql`ARRAY[]::text[]`),
    /**
     * The address, the thing typed after `@`. Lowercase, no spaces,
     * machine-read, unique within this org (ISS-1003).
     */
    handle: text('handle'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    userIdIdx: index('organization_members_user_id_idx').on(t.userId),
    orgHandleUnique: uniqueIndex('organization_members_org_handle_uniq')
      .on(t.orgId, t.handle)
      .where(sql`handle IS NOT NULL`),
    handleShape: check('organization_members_handle_shape', orgHandleText(t.handle)),
  }),
);

export const orgInvitations = pgTable(
  'org_invitations',
  {
    token: text('token').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: orgMemberRoles }).notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgEmailIdx: index('org_invitations_org_email_idx').on(t.orgId, t.email),
    orgEmailPendingUq: uniqueIndex('org_invitations_org_email_pending_uq')
      .on(t.orgId, t.email)
      .where(sql`accepted_at IS NULL`),
  }),
);

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  creator: one(users, { fields: [organizations.createdBy], references: [users.id] }),
  members: many(organizationMembers),
  projects: many(projects),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.orgId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [organizationMembers.userId], references: [users.id] }),
}));

export const issuePrefixAliases = pgTable(
  'issue_prefix_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references((): AnyPgColumn => projects.id, {
      onDelete: 'set null',
    }),
    prefix: text('prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    prefixUq: uniqueIndex('issue_prefix_aliases_prefix_uq').on(t.prefix),
    projectPrefixUq: unique('issue_prefix_aliases_project_prefix_uq').on(t.projectId, t.prefix),
    prefixShape: check(
      'issue_prefix_aliases_prefix_shape',
      sql`${t.prefix} ~ '^[A-Z][A-Z0-9]{1,5}$' AND ${t.prefix} <> 'ISS'`,
    ),
  }),
);

// The release vocabulary lives in `release-axes.ts` and is re-exported here, so every existing
// `from './db/schema.js'` importer still resolves it.
export * from './release-axes.js';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    agentConfig: jsonb('agent_config'),
    issuePrefix: text('issue_prefix'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdIdx: index('projects_org_id_idx').on(t.orgId),
    createdByIdx: index('projects_created_by_idx').on(t.createdBy),
    archivedAtIdx: index('projects_archived_at_idx').on(t.archivedAt),
    issuePrefixFk: foreignKey({
      name: 'projects_issue_prefix_fk',
      columns: [t.id, t.issuePrefix],
      foreignColumns: [issuePrefixAliases.projectId, issuePrefixAliases.prefix],
    }),
  }),
);

export const projectMemberRoles = ['admin', 'member', 'viewer'] as const;
export type ProjectMemberRole = (typeof projectMemberRoles)[number];

export const projectMembers = pgTable(
  'project_members',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role', { enum: projectMemberRoles }).notNull().default('member'),
    /** Permissions held on this project beyond the role's (`@forge/contracts/permissions`). */
    grants: text('grants').array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.projectId] }),
    projectIdIdx: index('project_members_project_id_idx').on(t.projectId),
  }),
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, { fields: [projects.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [projects.createdBy], references: [users.id] }),
  members: many(projectMembers),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const projectInvitations = pgTable(
  'project_invitations',
  {
    token: text('token').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: projectMemberRoles }).notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectEmailIdx: index('project_invitations_project_email_idx').on(t.projectId, t.email),
    projectEmailPendingUq: uniqueIndex('project_invitations_project_email_pending_uq')
      .on(t.projectId, t.email)
      .where(sql`accepted_at IS NULL`),
  }),
);

export const projectInvitationsRelations = relations(projectInvitations, ({ one }) => ({
  project: one(projects, {
    fields: [projectInvitations.projectId],
    references: [projects.id],
  }),
  inviter: one(users, {
    fields: [projectInvitations.inviterId],
    references: [users.id],
  }),
}));

export * from './device-vocabulary.js';

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    platform: text('platform', { enum: devicePlatforms }).notNull(),
    agentVersion: text('agent_version'),
    agentCommit: text('agent_commit'),
    status: text('status', { enum: deviceStatuses }).notNull().default('offline'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    pairedAt: timestamp('paired_at', { withTimezone: true }).notNull().defaultNow(),
    capabilities: jsonb('capabilities'),
    /**
     * The last declaration-gate condition this box reported, with the time core
     * heard it. Not `capabilities`: that is what a box declares it CAN do, this
     * is the condition it is IN (ISS-1192).
     */
    gateReport: jsonb('gate_report'),
    maxConcurrent: integer('max_concurrent').notNull().default(1),
    // cm:why the runner declares its job-pane ceiling and core holds no default (design agent-run-standing):
    // NULL is undeclared, served as such by masters/standing, never a guessed number
    maxJobPanes: integer('max_job_panes'),
    machineId: text('machine_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdIdx: index('devices_owner_id_idx').on(t.ownerId),
    ownerMachineIdx: index('devices_owner_machine_idx').on(t.ownerId, t.machineId),
    maxJobPanesChk: check(
      'devices_max_job_panes_chk',
      sql`${t.maxJobPanes} IS NULL OR ${t.maxJobPanes} BETWEEN 1 AND ${sql.raw(String(MASTER_JOB_PANES_MAX))}`,
    ),
  }),
);

export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 18 }).notNull(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY['read','write']::text[]`),
    projectIds: uuid('project_ids').array(),
    boundProjectId: uuid('bound_project_id').references(() => projects.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    permissions: text('permissions').array(),
    grantEpoch: integer('grant_epoch').notNull().default(1),
    rateLimitMax: integer('rate_limit_max'),
    /**
     * The person this credential was handed to act for, where it is not a token its holder minted
     * for themselves: a turn's token acts for the person it answers, a box's for whoever paired it.
     * Every act made with it records this beside the token (`permissions/actor.ts:Actor`).
     */
    onBehalfOf: uuid('on_behalf_of').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    userNameUq: uniqueIndex('pat_user_name_uniq').on(t.userId, t.name).where(isNull(t.revokedAt)),
    userActiveIdx: index('pat_user_active_idx').on(t.userId, t.revokedAt),
    tokenPrefixIdx: index('pat_token_prefix_idx').on(t.tokenPrefix),
    deviceIdIdx: index('pat_device_id_idx').on(t.deviceId),
    liveNameIdx: index('pat_live_name_idx').on(t.name).where(isNull(t.revokedAt)),
  }),
);

export const mcpAuditLog = pgTable(
  'mcp_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tokenId: uuid('token_id').references(() => personalAccessTokens.id, {
      onDelete: 'set null',
    }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    action: text('action'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    resultCode: text('result_code').notNull(),
    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    payloadDigest: varchar('payload_digest', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdIdx: index('mcp_audit_token_idx').on(t.tokenId, t.createdAt),
    userIdx: index('mcp_audit_user_idx').on(t.userId, t.createdAt),
    projectIdx: index('mcp_audit_project_idx').on(t.projectId, t.createdAt),
  }),
);

export const pairingCodes = pgTable(
  'pairing_codes',
  {
    code: text('code').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    grantEpoch: integer('grant_epoch').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('pairing_codes_user_id_idx').on(t.userId),
    projectIdIdx: index('pairing_codes_project_id_idx').on(t.projectId),
    expiresAtIdx: index('pairing_codes_expires_at_idx').on(t.expiresAt),
  }),
);

export const jobStatuses = JOB_STATUSES;
export type JobStatus = (typeof jobStatuses)[number];

export const jobTypes = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  'staging',
  'release',
  'fix',
  'custom',
  'smoke',
  'release_batch',
  'drive',
  // cm:why the project-onboarding analysis (ISS-63): an issue-less job whose prompt carries the whole
  // method, so the runner, which never branches on the type, needs no change
  'onboarding',
] as const;
export type JobType = (typeof jobTypes)[number];

export const modelTiers = ['haiku', 'sonnet', 'opus'] as const;
export type ModelTier = (typeof modelTiers)[number];

export const pipelineRunKinds = ['issue', 'interactive', 'system'] as const;
export type PipelineRunKind = (typeof pipelineRunKinds)[number];

export const pipelineRunStatuses = PIPELINE_RUN_STATUSES;
export type PipelineRunStatus = (typeof pipelineRunStatuses)[number];

export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind', { enum: pipelineRunKinds }).notNull().default('issue'),
    status: text('status', { enum: pipelineRunStatuses }).notNull().default('running'),
    currentStep: text('current_step'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    /** A release's version and its ship (ISS-1120); both NULL on every other kind of run. */
    ...axes.releaseRunVersionColumns,
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectStatusIdx: index('pipeline_runs_project_status_idx').on(t.projectId, t.status),
    issueIdx: index('pipeline_runs_issue_idx').on(t.issueId),
    projectStartedAtIdx: index('pipeline_runs_started_at_idx').on(t.projectId, t.startedAt),
    startedAtIdx: index('pipeline_runs_started_at_only_idx').on(t.startedAt),
    issueOpenUq: uniqueIndex('pipeline_runs_issue_open_uq')
      .on(t.issueId)
      .where(sql`kind = 'issue' AND status IN ('running','paused')`),
    ...axes.releaseRunIdentity(t),
  }),
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'set null' }),
    pipelineRunId: uuid('pipeline_run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    runnerId: uuid('runner_id').references((): AnyPgColumn => runners.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text('type', { enum: jobTypes }).notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status', { enum: jobStatuses }).notNull().default('queued'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    error: text('error'),
    modelTier: text('model_tier', { enum: modelTiers }),
    attempts: integer('attempts').notNull().default(1),
    cancellationRequested: boolean('cancellation_requested').notNull().default(false),
    killRequestedAt: timestamp('kill_requested_at', { withTimezone: true }),
    killConfirmedAt: timestamp('kill_confirmed_at', { withTimezone: true }),
    killOutcome: text('kill_outcome', {
      enum: ['killed', 'not_found', 'runner_gone', 'reported_terminal', 'never_claimed'],
    }),
    retryOf: uuid('retry_of').references((): AnyPgColumn => jobs.id, { onDelete: 'set null' }),
    // ISS-197 — when set, dispatch gate L1 skips this row until now() >=
    // retry_after_at. Written by the retry engine after a transient/timeout
    // failure with an optional provider Retry-After hint; NULL otherwise.
    retryAfterAt: timestamp('retry_after_at', { withTimezone: true }),
    agentSessionId: uuid('agent_session_id'),
    heldBy: uuid('held_by'),
    heldAt: timestamp('held_at', { withTimezone: true }),
    // Pipeline self-healing (Phase H, ISS-306; taxonomy rebuilt by ISS-450 /
    // ISS-442 C4). Set when the job ends in `failed`. failureKind drives the
    // per-class retry policy (code = no retry, transient-cc = immediate
    // device failover, infra/timeout = bounded round-robin). classifierVersion
    // pins the classifier rules at write time so old rows survive future
    // pattern changes without silent reclassification.
    failureKind: text('failure_kind', {
      enum: ['code', 'infra', 'transient-cc', 'timeout'],
    }),
    failureAction: text('failure_action', {
      enum: ['terminal', 'quarantine', 'failover', 'retry'],
    }),
    failureReason: text('failure_reason'),
    failureMeta: jsonb('failure_meta'),
    classifierVersion: integer('classifier_version'),
    // S1.1 — Prompt snapshot for Inspector + Analytics. system_prompt_hash
    // points at prompt_blobs (content-addressable dedup, ~70% storage win);
    // user_prompt_snapshot is the rendered `/skill id + ## Issue + ## Prev
    // Session Context` string inline because every job is unique here.
    // prompt_blocks is the per-block char/token breakdown for analytics.
    // archive_path is set by the retention sweeper once the row ages past
    // FORGE_PROMPT_RETENTION_DAYS.
    systemPromptHash: text('system_prompt_hash').references((): AnyPgColumn => promptBlobs.hash),
    userPromptSnapshot: text('user_prompt_snapshot'),
    promptInputTokenEst: integer('prompt_input_token_est'),
    modelUsed: text('model_used'),
    promptBlocks: jsonb('prompt_blocks'),
    archivePath: text('archive_path'),
    skillsRanWith: jsonb('skills_ran_with'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdx: index('jobs_project_id_idx').on(t.projectId),
    deviceIdIdx: index('jobs_device_id_idx').on(t.deviceId),
    issueIdIdx: index('jobs_issue_id_idx').on(t.issueId),
    statusIdx: index('jobs_status_idx').on(t.status),
    runnerIdIdx: index('jobs_runner_id_idx').on(t.runnerId),
    retryOfIdx: index('jobs_retry_of_idx').on(t.retryOf),
    agentSessionIdIdx: index('jobs_agent_session_id_idx').on(t.agentSessionId),
    killRequestedAtIdx: index('jobs_kill_requested_at_idx')
      .on(t.status, t.killRequestedAt)
      .where(sql`kill_requested_at IS NOT NULL`),
    activeUniqueIdx: uniqueIndex('jobs_active_unique')
      .on(t.issueId, t.type)
      .where(sql`status IN ('queued','dispatched','running','held') AND issue_id IS NOT NULL`),
    pipelineRunIdx: index('jobs_pipeline_run_idx').on(t.pipelineRunId),
    finishedArchiveIdx: index('jobs_finished_archive_idx')
      .on(t.finishedAt)
      .where(sql`archive_path IS NULL AND finished_at IS NOT NULL`),
    // ISS-455 — a project's smoke canaries, kept off the hot jobs rows.
    smokeProjectQueuedIdx: index('jobs_smoke_project_queued_idx')
      .on(t.projectId, t.queuedAt)
      .where(sql`type = 'smoke'`),
  }),
);

// S1.1 — Content-addressable store for system prompts. Many jobs share the
// same preamble (PIPELINE_RULES + TOOL_REFERENCE + branches) so we keep
// one row per unique hash and reference-count via jobs.system_prompt_hash.
// GC happens when ref_count hits 0 during retention sweep.
export const promptBlobs = pgTable('prompt_blobs', {
  hash: text('hash').primaryKey(),
  content: text('content').notNull(),
  firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  refCount: integer('ref_count').notNull().default(0),
});

export {
  CORE_WRITTEN_JOB_EVENT_KINDS,
  DEVICE_POSTED_JOB_EVENT_KINDS,
  type JobEventKind,
  jobEventKinds,
} from './job-event-kinds.js';

export const jobEvents = pgTable(
  'job_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind', { enum: jobEventKinds }).notNull(),
    data: jsonb('data').notNull().default({}),
    seq: integer('seq').notNull(),
  },
  (t) => ({
    jobIdSeqIdx: uniqueIndex('job_events_job_id_seq_idx').on(t.jobId, t.seq),
    tsIdx: index('job_events_ts_idx').on(t.ts),
    jobIdTsIdx: index('job_events_job_id_ts_idx').on(t.jobId, t.ts),
    resultKindIdx: index('job_events_result_idx').on(t.jobId).where(sql`kind = 'result'`),
    secretResolveIdx: index('job_events_secret_resolve_idx')
      .on(t.jobId)
      .where(sql`kind = 'secret_resolve'`),
  }),
);

// Append-only record of every status move on every machine (`@forge/contracts/machines`), written
// by the one kernel transition `lifecycle/transition.ts:transition` in the move's own transaction:
// one row per moved entity. `from_status` is the status the row actually left (read under the row
// lock); `actor_id` is a bare uuid (no FK), so a system actor records NULL. `from_status` and
// `to_status` are history: they carry no CHECK and keep a state a later machine version retired.
export const kernelTransitionEntities = MACHINE_ENTITIES;
export type KernelTransitionEntity = (typeof kernelTransitionEntities)[number];

export const kernelTransitionActorTypes = ['user', 'system', 'runner', 'sweeper'] as const;
export type KernelTransitionActorType = (typeof kernelTransitionActorTypes)[number];

export const kernelTransitions = pgTable(
  'kernel_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entity: text('entity', { enum: kernelTransitionEntities }).notNull(),
    entityId: uuid('entity_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    /** The version of the machine that judged the move (`StatusMachine.version`); null on a row
     *  recorded before machines were versioned. */
    machineVersion: integer('machine_version'),
    reason: text('reason'),
    actorType: text('actor_type', { enum: kernelTransitionActorTypes }).notNull(),
    actorAgency: text('actor_agency', { enum: actorAgencies }).notNull(),
    actorId: uuid('actor_id'),
    /** The credential the move was made with; null for a session or a system actor. */
    actorTokenId: uuid('actor_token_id'),
    /** The person that credential acts for (`personal_access_tokens.on_behalf_of`). */
    actorOnBehalfOf: uuid('actor_on_behalf_of'),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('kernel_transitions_entity_idx').on(t.entity, t.entityId),
    createdAtIdx: index('kernel_transitions_created_at_idx').on(t.createdAt),
    reasonIdx: index('kernel_transitions_reason_idx').on(t.reason),
  }),
);

/** A registered box, as every device-authenticated surface reads it. */
export type Device = InferSelectModel<typeof devices>;

export const devicesRelations = relations(devices, ({ one, many }) => ({
  owner: one(users, { fields: [devices.ownerId], references: [users.id] }),
  jobs: many(jobs),
}));

export const pairingCodesRelations = relations(pairingCodes, ({ one }) => ({
  user: one(users, { fields: [pairingCodes.userId], references: [users.id] }),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  project: one(projects, { fields: [jobs.projectId], references: [projects.id] }),
  device: one(devices, { fields: [jobs.deviceId], references: [devices.id] }),
  runner: one(runners, { fields: [jobs.runnerId], references: [runners.id] }),
  createdByUser: one(users, { fields: [jobs.createdBy], references: [users.id] }),
  pipelineRun: one(pipelineRuns, {
    fields: [jobs.pipelineRunId],
    references: [pipelineRuns.id],
  }),
  events: many(jobEvents),
}));

export const pipelineRunsRelations = relations(pipelineRuns, ({ one, many }) => ({
  project: one(projects, { fields: [pipelineRuns.projectId], references: [projects.id] }),
  issue: one(issues, { fields: [pipelineRuns.issueId], references: [issues.id] }),
  jobs: many(jobs),
  agentSessions: many(agentSessions),
}));

export const jobEventsRelations = relations(jobEvents, ({ one }) => ({
  job: one(jobs, { fields: [jobEvents.jobId], references: [jobs.id] }),
}));

// EPIC 2 (ISS-271) — Runner framework.
// A `runner` is a capability handle the dispatcher targets; concrete behaviour
// lives in a `RunnerAdapter` registered by `bootstrapRunnerAdapters()`.
// EPIC 2 owns the schema. EPIC 3 Phase B (ISS-272 follow-up) layers admin
// dashboard reads on top — do not redesign these columns there.
export const runnerTypes = ['claude-code'] as const;
export type RunnerType = (typeof runnerTypes)[number];

export const runnerStatuses = RUNNER_STATUSES;

export const runnerLimitReasons = ['usage_limit', 'rate_limit', 'auth'] as const;
export type RunnerLimitReason = (typeof runnerLimitReasons)[number];

// Per (device × project) workspace provisioning lifecycle: `@forge/contracts/runner-machine:RUNNER_PROVISION_MACHINE`.
export const runnerProvisionStatuses = RUNNER_PROVISION_STATUSES;
export type RunnerProvisionStatus = (typeof runnerProvisionStatuses)[number];
export type RunnerStatus = (typeof runnerStatuses)[number];

export const runners = pgTable(
  'runners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type', { enum: runnerTypes }).notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    labels: jsonb('labels').notNull().default([]),
    capabilities: jsonb('capabilities').notNull().default({}),
    config: jsonb('config').notNull().default({}),
    // ISS-271 — per (device × project) repo checkout: the only place a checkout is named, written
    // by web (PATCH) or CLI (`forge-runner bind`).
    repoPath: text('repo_path'),
    branch: text('branch'),
    status: text('status', { enum: runnerStatuses }).notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastError: text('last_error'),
    limitReason: text('limit_reason', { enum: runnerLimitReasons }),
    rateLimitedUntil: timestamp('rate_limited_until', { withTimezone: true }),
    limitDetail: text('limit_detail'),
    quarantinedUntil: timestamp('quarantined_until', { withTimezone: true }),
    quarantineReason: text('quarantine_reason'),
    // Per (device × project) workspace provisioning state. NULL = not yet
    // provisioned / legacy row. The runner advances this via the device
    // provision-status report; web renders it as a live stepper. `queued` is
    // the offline hand-off — a device that's offline picks the job up on next
    // connect (pull model), so bind never blocks on device presence.
    provisionStatus: text('provision_status', { enum: runnerProvisionStatuses }),
    // Human-readable last detail (clone error, "folder missing", skill count…).
    provisionDetail: text('provision_detail'),
    // When the current provision request was enqueued (queue ordering + re-run).
    provisionRequestedAt: timestamp('provision_requested_at', { withTimezone: true }),
    // When provision last reached a terminal `ready`.
    provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
    // The box's failed reads of this project's job pool, off the heartbeat (ISS-1234).
    poolRead: jsonb('pool_read'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectTypeStatusIdx: index('runners_project_type_status_idx').on(
      t.projectId,
      t.type,
      t.status,
    ),
    projectDeviceTypeUq: uniqueIndex('runners_project_device_type_uq').on(
      t.projectId,
      t.deviceId,
      t.type,
    ),
  }),
);

export const runnersRelations = relations(runners, ({ one, many }) => ({
  project: one(projects, { fields: [runners.projectId], references: [projects.id] }),
  device: one(devices, { fields: [runners.deviceId], references: [devices.id] }),
  jobs: many(jobs),
}));

/**
 * What a `needs_info` park is stopped on. `needs_answer` is a question; the other two are the old
 * `waiting` park's kinds, which folded into `needs_info` with their kind kept (ISS-54).
 */
export const waitingKinds = ['needs_answer', 'needs_decision', 'needs_resource'] as const;
export type WaitingKind = (typeof waitingKinds)[number];

/**
 * The ten statuses of workflow `issue-lifecycle`, declared once in contracts. A status answers only
 * "who is it waiting on"; a run's step is progress inside `in_progress`, in `issue_work_state`.
 */
export const issueStatuses = ISSUE_STATUSES;
export type IssueStatus = (typeof issueStatuses)[number];

export const issuePriorities = ['critical', 'high', 'medium', 'low', 'none'] as const;
export type IssuePriority = (typeof issuePriorities)[number];

// ISS-42 C2 — t-shirt sizing for issue scope. Mirrored by the
// `issues_complexity_chk` CHECK constraint (migration 0046). NULL means
// "not yet sized".
export const issueComplexities = ['xs', 's', 'm', 'l', 'xl'] as const;
export type IssueComplexity = (typeof issueComplexities)[number];

export const issueSources = ['manual', 'github', 'sentry'] as const;
export type IssueSource = (typeof issueSources)[number];

export const issueCreationChannels = ['web', 'mcp', 'pipeline', 'schedule', 'system'] as const;
export type IssueCreationChannel = (typeof issueCreationChannels)[number];

export const projectIssCounters = pgTable('project_iss_counters', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  nextSeq: integer('next_seq').notNull().default(1),
});

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issSeq: integer('iss_seq').notNull().default(0),
    title: text('title').notNull(),
    description: text('description'),
    descriptionFormat: text('description_format', { enum: BODY_FORMATS })
      .notNull()
      .default('markdown'),
    status: text('status', { enum: issueStatuses }).notNull().default('open'),
    priority: text('priority', { enum: issuePriorities }).notNull().default('medium'),
    category: text('category'),
    // Set by webhook/MCP imports; NULL when `createdById` covers the actor.
    reportedBy: text('reported_by'),
    createdVia: text('created_via', { enum: issueCreationChannels }),
    detectorKey: text('detector_key'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The paired box whose credential filed it, `createdById` its holder; NULL for an account's own write. */
    createdByDeviceId: uuid('created_by_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergedCommitSha: text('merged_commit_sha'),
    mergedLanding: text('merged_landing'),
    mergedTarget: text('merged_target'),
    // ISS-42 C2 — t-shirt sizing (xs/s/m/l/xl) for scoping. NULL = unsized.
    complexity: text('complexity', { enum: issueComplexities }),
    reopenCount: integer('reopen_count').notNull().default(0),
    waitingKind: text('waiting_kind', { enum: waitingKinds }),
    source: text('source', { enum: issueSources }).notNull().default('manual'),
    externalId: text('external_id'),
    plan: text('plan'),
    acceptanceCriteria: text('acceptance_criteria'),
    sessionContext: jsonb('session_context'),
    // ISS-199 — user-facing release notes. Written by forge-clarify per
    // issue, read by forge-release at close time to append a CHANGELOG.md
    // `## [Unreleased]` bullet. Shape validated at the app layer; see
    // `release-notes.ts` for the zod schema.
    releaseNotes: jsonb('release_notes').$type<ReleaseNotes | null>(),
    // ISS-137 — Layer 2 branch config (per-issue override) lives here under
    // `branchConfig`. Free-form jsonb so other per-issue settings can land
    // here later without further migrations. NULL = no override; see
    // packages/core/src/branches/resolve.ts for the resolution order.
    metadata: jsonb('metadata').$type<
      | ({
          branchConfig?: IssueBranchOverride | null;
        } & Record<string, unknown>)
      | null
    >(),
    releaseBatchRunId: uuid('release_batch_run_id').references(() => pipelineRuns.id, {
      onDelete: 'set null',
    }),
    // cm:why optional: a maintenance issue serves no requirement. planned_revision is the requirement
    // revision the plan was written against, set when the plan is written (ISS-57)
    requirementId: uuid('requirement_id').references(() => requirements.id),
    plannedRevision: integer('planned_revision'),
    // cm:why which baseline at planned_revision the plan read: a re-pin onto newly approved designs
    // writes a later one at the same revision, and a plan that predates it has changed since (ISS-86)
    plannedBaselineSeq: integer('planned_baseline_seq'),
    // cm:why an issue filed as an accepted suggestion's effect points back at it, as a revision does
    // (workflow suggestion-lifecycle step accepted)
    fromSuggestionId: uuid('from_suggestion_id').references((): AnyPgColumn => suggestions.id, {
      onDelete: 'no action',
    }),
    // cm:why the fire an issue was filed in (design automation rev 1, step settle; ISS-114): resolved
    // at create through the creating session's fire, or written by the fire that filed it inline, so
    // Fire.produced counts issues by join; a person's own create carries none
    scheduleRunId: uuid('schedule_run_id').references((): AnyPgColumn => scheduleRuns.id, {
      onDelete: 'set null',
    }),
    identSearch: identSearchColumn(
      (): SQL =>
        sql`left(${issues.title} || ' ' || coalesce(${issues.description}, '') || ' ' || coalesce(${issues.plan}, '') || ' ' || coalesce(${issues.acceptanceCriteria}, ''), 100000)`,
    ),
    // ISS-1237 — set = archived; which reads still answer it is `issues/archive-readers.test.ts`.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    descriptionFormatChk: check(
      'issues_description_format_chk',
      sql`${t.descriptionFormat} IN ('markdown', 'html')`,
    ),
    mergedLandingChk: check(
      'issues_merged_landing_chk',
      sql`${t.mergedLanding} IS NULL OR (${t.mergedAt} IS NOT NULL AND ${t.mergedLanding} ~ '[^[:space:]]' AND char_length(${t.mergedLanding}) <= 2000)`,
    ),
    projectIssSeqUq: uniqueIndex('issues_project_iss_seq_uq').on(t.projectId, t.issSeq),
    projectStatusIdx: index('issues_project_status_idx').on(t.projectId, t.status),
    assigneeIdx: index('issues_assignee_idx').on(t.assigneeId),
    projectSourceExternalIdUq: uniqueIndex('issues_project_source_external_id_uq')
      .on(t.projectId, t.source, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    identSearchIdx: index('issues_ident_search_idx').using('gin', t.identSearch),
    titleTrgmIdx: index('issues_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
    descriptionTrgmIdx: index('issues_description_trgm_idx').using(
      'gin',
      sql`${t.description} gin_trgm_ops`,
    ),
    planTrgmIdx: index('issues_plan_trgm_idx').using('gin', sql`${t.plan} gin_trgm_ops`),
    acceptanceCriteriaTrgmIdx: index('issues_acceptance_criteria_trgm_idx').using(
      'gin',
      sql`${t.acceptanceCriteria} gin_trgm_ops`,
    ),
    projectCreatedAtIdx: index('issues_project_created_at_idx').on(t.projectId, t.createdAt),
    scheduleRunIdx: index('issues_schedule_run_idx')
      .on(t.scheduleRunId)
      .where(sql`schedule_run_id IS NOT NULL`),
    projectUpdatedAtIdx: index('issues_project_updated_at_idx').on(t.projectId, t.updatedAt),
    releaseBatchRunIdIdx: index('issues_release_batch_run_id_idx')
      .on(t.releaseBatchRunId)
      .where(sql`release_batch_run_id IS NOT NULL`),
    archivedAtIdx: index('issues_archived_at_idx').on(t.archivedAt),
    requirementIdx: index('issues_requirement_idx')
      .on(t.requirementId)
      .where(sql`requirement_id IS NOT NULL`),
    plannedRevisionFk: foreignKey({
      name: 'issues_planned_revision_fk',
      columns: [t.requirementId, t.plannedRevision],
      foreignColumns: [requirementRevisions.requirementId, requirementRevisions.revision],
    }),
    plannedRevisionChk: check(
      'issues_planned_revision_chk',
      sql`${t.plannedRevision} IS NULL OR ${t.requirementId} IS NOT NULL`,
    ),
    plannedBaselineChk: check(
      'issues_planned_baseline_chk',
      sql`${t.plannedBaselineSeq} IS NULL OR (${t.plannedRevision} IS NOT NULL AND ${t.plannedBaselineSeq} >= 1)`,
    ),
  }),
);

// cm:guard a comment sits on exactly one target (ISS-83): an exclusive arc of real foreign keys,
// each cascading with its target, held by comments_scope_chk so no door can write an orphan or a twin
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'cascade',
    }),
    workflowId: uuid('workflow_id').references((): AnyPgColumn => projectWorkflows.id, {
      onDelete: 'cascade',
    }),
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'cascade',
    }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    authorDeviceId: uuid('author_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    format: text('format', { enum: BODY_FORMATS }).notNull().default('markdown'),
    stage: text('stage'),
    parentId: uuid('parent_id'),
    /**
     * ISS-56 — what the comment means to do: `question` is owed a reply, `decision` is pinned,
     * `note` is neither. The REST and MCP doors decide it by name; the default is what a system
     * write that declares nothing means.
     */
    intent: text('intent', { enum: COMMENT_INTENTS }).notNull().default('note'),
    decision: jsonb('decision').$type<DecisionFields>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    formatChk: check('comments_format_chk', sql`${t.format} IN ('markdown', 'html')`),
    intentChk: check('comments_intent_chk', sql`${t.intent} IN ('question', 'decision', 'note')`),
    scopeChk: check(
      'comments_scope_chk',
      sql`num_nonnulls(${t.issueId}, ${t.requirementId}, ${t.workflowId}, ${t.feedbackId}) = 1`,
    ),
    decisionIntentChk: check(
      'comments_decision_intent_chk',
      sql`${t.decision} IS NULL OR ${t.intent} = 'decision'`,
    ),
    // cm:hack ISS-83 until:forge-plugin sends decision fields on an issue decision — issue decisions
    // stay prose, so the structured body is required on every other scope only
    decisionFieldsChk: check(
      'comments_decision_fields_chk',
      sql`${t.intent} <> 'decision' OR ${t.issueId} IS NOT NULL OR COALESCE(jsonb_typeof(${t.decision} -> 'decision') = 'string' AND jsonb_typeof(${t.decision} -> 'reason') = 'string' AND (${t.decision} ->> 'decision') ~ '[^[:space:]]' AND (${t.decision} ->> 'reason') ~ '[^[:space:]]', false)`,
    ),
    issueIdx: index('comments_issue_id_idx').on(t.issueId),
    issueCreatedIdx: index('comments_issue_created_idx').on(t.issueId, t.createdAt, t.id),
    requirementCreatedIdx: index('comments_requirement_created_idx')
      .on(t.requirementId, t.createdAt, t.id)
      .where(sql`requirement_id IS NOT NULL`),
    workflowCreatedIdx: index('comments_workflow_created_idx')
      .on(t.workflowId, t.createdAt, t.id)
      .where(sql`workflow_id IS NOT NULL`),
    feedbackCreatedIdx: index('comments_feedback_created_idx')
      .on(t.feedbackId, t.createdAt, t.id)
      .where(sql`feedback_id IS NOT NULL`),
    decisionCreatedIdx: index('comments_decision_created_idx')
      .on(t.createdAt, t.id)
      .where(sql`intent = 'decision'`),
    parentIdx: index('comments_parent_id_idx').on(t.parentId),
    parentFk: foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: 'comments_parent_id_fk',
    }).onDelete('cascade'),
  }),
);

export const labelKinds = ['label', 'module'] as const;
export type LabelKind = (typeof labelKinds)[number];

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    kind: text('kind', { enum: labelKinds }).notNull().default('label'),
    parentId: uuid('parent_id').references((): AnyPgColumn => labels.id, { onDelete: 'set null' }),
    slug: text('slug'),
    knowledgeEntryId: uuid('knowledge_entry_id').references(() => knowledgeEntries.id, {
      onDelete: 'set null',
    }),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectNameUq: uniqueIndex('labels_project_id_name_uq').on(t.projectId, t.name),
    parentIdx: index('labels_parent_id_idx').on(t.parentId),
    projectSlugUq: uniqueIndex('labels_project_id_slug_uq').on(t.projectId, t.slug),
    knowledgeEntryUq: uniqueIndex('labels_knowledge_entry_id_uq').on(t.knowledgeEntryId),
    slugChk: check('labels_slug_chk', sql`(${t.kind} = 'module') = (${t.slug} IS NOT NULL)`),
    nodeChk: check(
      'labels_knowledge_entry_chk',
      sql`${t.kind} = 'module' OR ${t.knowledgeEntryId} IS NULL`,
    ),
    kindChk: check('labels_kind_chk', sql`${t.kind} IN ('label', 'module')`),
  }),
);

export const issueLabels = pgTable(
  'issue_labels',
  {
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.labelId] }),
    labelIdx: index('issue_labels_label_id_idx').on(t.labelId),
    primaryUq: uniqueIndex('issue_labels_primary_uq').on(t.issueId).where(sql`is_primary = true`),
  }),
);

export const issuesRelations = relations(issues, ({ one, many }) => ({
  project: one(projects, { fields: [issues.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [issues.assigneeId], references: [users.id] }),
  createdBy: one(users, { fields: [issues.createdById], references: [users.id] }),
  comments: many(comments),
  labels: many(issueLabels),
  activity: many(activityLog),
  attachments: many(issueAttachments),
}));

export const commentsRelations = relations(comments, ({ one, many }) => ({
  issue: one(issues, { fields: [comments.issueId], references: [issues.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
    relationName: 'comment_parent',
  }),
  replies: many(comments, { relationName: 'comment_parent' }),
  attachments: many(commentAttachments),
  mentions: many(commentMentions),
}));

export const commentMentions = pgTable(
  'comment_mentions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.commentId, t.userId] }),
    userIdx: index('comment_mentions_user_id_idx').on(t.userId),
  }),
);

export const commentMentionsRelations = relations(commentMentions, ({ one }) => ({
  comment: one(comments, { fields: [commentMentions.commentId], references: [comments.id] }),
  user: one(users, { fields: [commentMentions.userId], references: [users.id] }),
}));

export const commentAttachments = pgTable(
  'comment_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Populated when the uploader was a device principal (MCP path).
    // Null for user-principal uploads (REST multipart). Matches the
    // (user notNull, device nullable) audit shape used by `jobs`.
    uploaderDeviceId: uuid('uploader_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    commentIdx: index('comment_attachments_comment_id_idx').on(t.commentId),
    uploaderDeviceIdx: index('comment_attachments_uploader_device_id_idx').on(t.uploaderDeviceId),
  }),
);

export const commentAttachmentsRelations = relations(commentAttachments, ({ one }) => ({
  comment: one(comments, { fields: [commentAttachments.commentId], references: [comments.id] }),
  uploader: one(users, { fields: [commentAttachments.uploaderId], references: [users.id] }),
  uploaderDevice: one(devices, {
    fields: [commentAttachments.uploaderDeviceId],
    references: [devices.id],
  }),
}));

export const issueAttachments = pgTable(
  'issue_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('issue_attachments_issue_id_idx').on(t.issueId),
  }),
);

export const issueAttachmentsRelations = relations(issueAttachments, ({ one }) => ({
  issue: one(issues, { fields: [issueAttachments.issueId], references: [issues.id] }),
  uploader: one(users, { fields: [issueAttachments.uploaderId], references: [users.id] }),
}));

export const labelsRelations = relations(labels, ({ one, many }) => ({
  project: one(projects, { fields: [labels.projectId], references: [projects.id] }),
  parent: one(labels, {
    fields: [labels.parentId],
    references: [labels.id],
    relationName: 'labelHierarchy',
  }),
  children: many(labels, { relationName: 'labelHierarchy' }),
  issues: many(issueLabels),
}));

export const issueLabelsRelations = relations(issueLabels, ({ one }) => ({
  issue: one(issues, { fields: [issueLabels.issueId], references: [issues.id] }),
  label: one(labels, { fields: [issueLabels.labelId], references: [labels.id] }),
}));

export const skillScopes = ['global', 'project'] as const;
export type SkillScope = (typeof skillScopes)[number];

export const skillSources = ['builtin', 'user'] as const;
export type SkillSource = (typeof skillSources)[number];

export const skillTargets = ['dev', 'cloud', 'all'] as const;
export type SkillTarget = (typeof skillTargets)[number];

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    scope: text('scope', { enum: skillScopes }).notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    // ISS-2A: forward-compat for Phase 2 user-scope skills. Nullable today;
    // a CHECK constraint at the DB level pins each row to one scope (the app
    // enum stays at ['global','project'] until Phase 2 adds 'user').
    userId: uuid('user_id').references((): AnyPgColumn => users.id, {
      onDelete: 'cascade',
    }),
    prompt: text('prompt').notNull(),
    tools: jsonb('tools').notNull().default([]),
    manifest: jsonb('manifest').notNull().default({}),
    source: text('source', { enum: skillSources }).notNull(),
    version: integer('version').notNull().default(1),
    contentHash: text('content_hash').notNull(),
    evalScore: real('eval_score'),
    skillMd: text('skill_md'),
    target: text('target', { enum: skillTargets }),
    files: jsonb('files').notNull().default([]),
    changelog: jsonb('changelog').notNull().default([]),
    localGuide: text('local_guide'),
    basedOnGlobalSkillId: uuid('based_on_global_skill_id'),
    basedOnGlobalVersion: integer('based_on_global_version'),
    pinned: boolean('pinned').notNull().default(false),
    pinnedReason: text('pinned_reason'),
    pinnedBy: text('pinned_by'),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    // When true, a project-scoped skill is synced to device runners (enters the
    // device manifest): a manual / user-invocable utility skill (e.g.
    // forge-product-map) lives on the runner without the dispatcher running it.
    installOnly: boolean('install_only').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('skills_project_id_idx').on(t.projectId),
    scopeIdx: index('skills_scope_idx').on(t.scope),
    userIdx: index('skills_user_id_idx').on(t.userId),
    globalNameUq: uniqueIndex('skills_name_global_uq').on(t.name).where(sql`scope = 'global'`),
    projectNameUq: uniqueIndex('skills_project_name_uq')
      .on(t.projectId, t.name)
      .where(sql`scope = 'project'`),
  }),
);

export const skillActivityOutcomes = ['ok', 'failed', 'skipped'] as const;
export type SkillActivityOutcome = (typeof skillActivityOutcomes)[number];

export const skillActivityEvents = pgTable(
  'skill_activity_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    packetId: text('packet_id'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    eventType: text('event_type', { enum: skillActivityEventTypes }).notNull(),
    actor: text('actor').notNull(),
    trigger: text('trigger', { enum: skillActivityTriggers }).notNull(),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    deltaSummary: text('delta_summary'),
    reason: text('reason'),
    outcome: text('outcome', { enum: skillActivityOutcomes }).notNull().default('ok'),
  },
  (t) => ({
    packetIdx: index('skill_activity_events_packet_idx').on(t.packetId, t.occurredAt),
    skillIdx: index('skill_activity_events_skill_idx').on(t.projectId, t.skillId, t.occurredAt),
    deviceIdx: index('skill_activity_events_device_idx').on(t.deviceId, t.occurredAt),
  }),
);

export const memorySources = [
  'issue',
  'comment',
  'job',
  'note',
  'knowledge',
  'decision',
  'policy',
] as const;
export type MemorySource = (typeof memorySources)[number];

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source', { enum: memorySources }).notNull(),
    sourceRef: text('source_ref').notNull(),
    textContent: text('text_content').notNull(),
    // Nullable since memory-v2 phase 1: a degraded write (embeddings outage)
    // stores the row without a vector and the re-embed backfill fills it in.
    // Semantic search filters `embedding IS NOT NULL`.
    embedding: pgVector(MEMORY_EMBEDDING_DIM)('embedding'),
    metadata: jsonb('metadata').notNull().default({}),
    // memory-v2 phase 2 usage tracking: bumped on semantic-search hits only
    // (not natural-key gets) and read by the decay/consolidation jobs.
    retrievalCount: integer('retrieval_count').notNull().default(0),
    lastRetrievedAt: timestamp('last_retrieved_at', { withTimezone: true }),
    // Recall-feedback loop (ISS-603): stamped when an agent verifies the row
    // against live code (`feedback` verdict=confirmed). Decay treats it as
    // activity so a recently-confirmed row is never archived as unused.
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    // Soft delete for decay/consolidation. Archived rows are excluded from
    // every read surface; hard purge happens after a further grace period.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // memory-v2 phase 1 keyword retrieval. GENERATED ALWAYS in Postgres
    // (migration 0105) — drizzle must never include it in INSERT/UPDATE.
    textSearch: tsVector('text_search').generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', left(${memories.textContent}, 100000))`,
    ),
    identSearch: identSearchColumn((): SQL => sql`left(${memories.textContent}, 100000)`),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSourceIdx: index('memories_project_source_idx').on(t.projectId, t.source),
    projectSourceRefIdx: index('memories_project_source_ref_idx').on(t.projectId, t.sourceRef),
    projectSourceRefUq: uniqueIndex('memories_project_source_ref_uq').on(
      t.projectId,
      t.source,
      t.sourceRef,
    ),
    embeddingHnswIdx: index('memories_embedding_hnsw_idx').using(
      'hnsw',
      sql`"embedding" vector_cosine_ops`,
    ),
    textSearchIdx: index('memories_text_search_idx').using('gin', t.textSearch),
    identSearchIdx: index('memories_ident_search_idx').using('gin', t.identSearch),
    embeddingBackfillIdx: index('memories_embedding_backfill_idx')
      .on(t.updatedAt)
      .where(sql`embedding IS NULL`),
  }),
);

export const skillsRelations = relations(skills, ({ one }) => ({
  project: one(projects, { fields: [skills.projectId], references: [projects.id] }),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  project: one(projects, { fields: [memories.projectId], references: [projects.id] }),
}));

export const knowledgeKinds = [
  'overview',
  'scenario',
  'workflow',
  'rule',
  'guide',
  'reference',
  'glossary',
] as const;

export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: knowledgeKinds }).notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    injection: text('injection', { enum: ['always', 'on_demand', 'none'] })
      .notNull()
      .default('on_demand'),
    /**
     * When this entry is worth reading, or `null` where nobody has said
     * (ISS-1313). `{ verbs?: MasterVerb[], statuses?: IssueStatus[] }`, held to
     * that shape by `knowledge_entries_read_when_chk`. It is a second axis
     * beside `injection` and not a replacement for it: `injection` decides
     * whether an entry is carried into every prompt, and this decides whether
     * it is worth fetching for the act in hand. Never a file glob — a master
     * dispatches and moves issues rather than editing files.
     */
    readWhen: jsonb('read_when'),
    confidence: text('confidence', { enum: ['verified', 'inferred', 'deprecated'] })
      .notNull()
      .default('inferred'),
    relatedIssueIds: jsonb('related_issue_ids').notNull().default([]),
    tags: jsonb('tags').notNull().default([]),
    orderIndex: integer('order_index').notNull().default(0),
    authoredBy: text('authored_by', { enum: ['human', 'agent', 'imported'] })
      .notNull()
      .default('agent'),
    embedding: pgVector(MEMORY_EMBEDDING_DIM)('embedding'),
    textSearch: tsVector('text_search').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', left(${knowledgeEntries.title} || ' ' || ${knowledgeEntries.body}, 100000))`,
    ),
    identSearch: identSearchColumn(
      (): SQL => sql`left(${knowledgeEntries.title} || ' ' || ${knowledgeEntries.body}, 100000)`,
    ),
    metadata: jsonb('metadata').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectKindIdx: index('knowledge_entries_project_kind_idx').on(t.projectId, t.kind),
    projectSlugUq: uniqueIndex('knowledge_entries_project_slug_uq').on(t.projectId, t.slug),
    embeddingHnswIdx: index('knowledge_entries_embedding_hnsw_idx').using(
      'hnsw',
      sql`"embedding" vector_cosine_ops`,
    ),
    textSearchIdx: index('knowledge_entries_text_search_idx').using('gin', t.textSearch),
    identSearchIdx: index('knowledge_entries_ident_search_idx').using('gin', t.identSearch),
    embeddingBackfillIdx: index('knowledge_entries_embedding_backfill_idx')
      .on(t.updatedAt)
      .where(sql`embedding IS NULL AND archived_at IS NULL`),
    // Mirrors `parseReadWhen` (ISS-1313); declared here too so drizzle-kit's model has it.
    readWhenChk: check(
      'knowledge_entries_read_when_chk',
      sql`knowledge_read_when_ok(${t.readWhen})`,
    ),
  }),
);

export const knowledgeEntriesRelations = relations(knowledgeEntries, ({ one }) => ({
  project: one(projects, { fields: [knowledgeEntries.projectId], references: [projects.id] }),
}));

export const scheduleModes = ['propose', 'auto'] as const;
export type ScheduleMode = (typeof scheduleModes)[number];

export const scheduleKinds = SCHEDULE_KINDS;

export type ScheduleKind = (typeof scheduleKinds)[number];

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    // ISS-618 — nullable: a script-kind schedule has no prompt at all.
    // App-layer validation enforces prompt-required for kind='prompt'.
    prompt: text('prompt'),
    enabled: boolean('enabled').notNull().default(true),
    targetProjectSlug: text('target_project_slug'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    templateKey: text('template_key'),
    params: jsonb('params'),
    mode: text('mode', { enum: scheduleModes }),
    kind: text('kind', { enum: scheduleKinds }).notNull().default('prompt'),
    script: text('script'),
    /**
     * Who a cron firing acts as (ISS-30): whoever last saved the schedule. Null once that account
     * is gone, which refuses the run by name until an admin saves it again.
     */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectEnabledIdx: index('schedules_project_enabled_idx').on(t.projectId, t.enabled),
    nextRunAtIdx: index('schedules_next_run_at_idx').on(t.nextRunAt).where(sql`enabled = true`),
    templateKeyIdx: index('schedules_template_key_idx')
      .on(t.projectId, t.templateKey)
      .where(sql`template_key is not null`),
  }),
);

export const schedulesRelations = relations(schedules, ({ one }) => ({
  project: one(projects, { fields: [schedules.projectId], references: [projects.id] }),
}));

export * from './schema-schedule-runs.js';

export const usageSources = ['cli', 'api', 'desktop'] as const;
export type UsageSource = (typeof usageSources)[number];

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source', { enum: usageSources }).notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    estimatedCost: real('estimated_cost').notNull().default(0),
    requestCount: integer('request_count').notNull().default(1),
    sessionId: text('session_id'),
    projectName: text('project_name'),
    jobId: uuid('job_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRecordedIdx: index('usage_records_project_recorded_idx').on(t.projectId, t.recordedAt),
    recordedAtIdx: index('usage_records_recorded_at_idx').on(t.recordedAt),
    sessionIdIdx: index('usage_records_session_id_idx').on(t.sessionId),
    sessionIdChk: check('usage_records_session_id_uuid_chk', canonicalUuidText(t.sessionId)),
    jobIdUq: uniqueIndex('usage_records_job_id_key').on(t.jobId).where(sql`job_id IS NOT NULL`),
  }),
);

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  project: one(projects, { fields: [usageRecords.projectId], references: [projects.id] }),
}));

export * from './schema-notifications.js';

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    // ISS-101 — every agent_session belongs to a pipeline_run. Pipeline jobs
    // inherit the parent job's run; user-driven chat sessions get a one-shot
    // 'interactive' run each. NOT NULL is enforced at the DB level by 0054.
    pipelineRunId: uuid('pipeline_run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'restrict' }),
    title: text('title'),
    status: text('status', { enum: agentSessionStatuses }).notNull().default('idle'),
    messages: jsonb('messages').notNull().default(sql`'[]'::jsonb`),
    claudeSessionId: text('claude_session_id'),
    repoPath: text('repo_path'),
    usage: jsonb('usage'),
    metadata: jsonb('metadata'),
    kind: text('kind', { enum: agentSessionKinds }).notNull(),
    /** Who owns this session, as CORE issued it — never as a box reported it. */
    parentSessionId: uuid('parent_session_id'),
    diff: jsonb('diff'),
    pipelineControl: jsonb('pipeline_control').$type<
      import('@forge/contracts/pipeline-control').PipelineControl | null
    >(),
    pipelineTelemetry: jsonb('pipeline_telemetry'),
    pipelineHealth: jsonb('pipeline_health').$type<
      import('@forge/contracts/pipeline-control').PipelineHealth | null
    >(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    failureReason: text('failure_reason', { enum: agentSessionFailureReasons }),
    failureDetail: text('failure_detail'),
    runtimeState: text('runtime_state', { enum: sessionRuntimeStates }),
    lastInboxSeq: integer('last_inbox_seq').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectStatusIdx: index('agent_sessions_project_status_idx').on(t.projectId, t.status),
    deviceIdx: index('agent_sessions_device_idx').on(t.deviceId),
    userIdx: index('agent_sessions_user_idx').on(t.userId),
    statusHeartbeatIdx: index('agent_sessions_status_heartbeat_idx').on(
      t.status,
      t.lastHeartbeatAt,
    ),
    statusDispatchedIdx: index('agent_sessions_status_dispatched_idx').on(t.status, t.dispatchedAt),
    pipelineRunIdx: index('agent_sessions_pipeline_run_idx').on(t.pipelineRunId),
    kindStatusIdx: index('agent_sessions_kind_status_idx').on(t.kind, t.status),
    // One live master per (device, project) was an intention held by a select
    // running before an insert. This makes it a fact; `ensureMasterSession`
    // keeps an advisory lock so the loser waits rather than raising.
    oneLiveMasterUq: uniqueIndex('agent_sessions_one_live_master_uq')
      .on(t.deviceId, t.projectId)
      .where(
        sql`kind = 'master' AND status NOT IN ('completed', 'failed', 'completed_via_recovery', 'cancelled_stale', 'cancelled')`,
      ),
    parentIdx: index('agent_sessions_parent_idx').on(t.parentSessionId),
    parentFk: foreignKey({
      columns: [t.parentSessionId],
      foreignColumns: [t.id],
      name: 'agent_sessions_parent_session_id_fkey',
    }).onDelete('set null'),
  }),
);

export const agentSessionsRelations = relations(agentSessions, ({ many, one }) => ({
  project: one(projects, { fields: [agentSessions.projectId], references: [projects.id] }),
  user: one(users, { fields: [agentSessions.userId], references: [users.id] }),
  device: one(devices, { fields: [agentSessions.deviceId], references: [devices.id] }),
  pipelineRun: one(pipelineRuns, {
    fields: [agentSessions.pipelineRunId],
    references: [pipelineRuns.id],
  }),
  turns: many(agentSessionTurns),
}));

// Sibling table that materializes each entry of `agent_sessions.messages` into
// its own row so turns can be addressed by id. The jsonb blob remains the
// source of truth during the dual-write rollout.
export const agentSessionTurnRoles = ['user', 'assistant', 'tool'] as const;
export type AgentSessionTurnRole = (typeof agentSessionTurnRoles)[number];

export const agentSessionTurns = pgTable(
  'agent_session_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentSessionId: uuid('agent_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    turnIndex: integer('turn_index').notNull(),
    role: text('role', { enum: agentSessionTurnRoles }).notNull(),
    content: jsonb('content').notNull(),
    parentTurnId: uuid('parent_turn_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => ({
    sessionIndexUnique: uniqueIndex('agent_session_turns_session_index_unique').on(
      t.agentSessionId,
      t.turnIndex,
    ),
    parentIdx: index('agent_session_turns_parent_idx').on(t.parentTurnId),
  }),
);

export const agentSessionTurnsRelations = relations(agentSessionTurns, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionTurns.agentSessionId],
    references: [agentSessions.id],
  }),
  parent: one(agentSessionTurns, {
    fields: [agentSessionTurns.parentTurnId],
    references: [agentSessionTurns.id],
    relationName: 'agent_session_turns_parent',
  }),
}));

export const sessionAttachments = pgTable(
  'session_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    uploaderDeviceId: uuid('uploader_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('session_attachments_session_id_idx').on(t.sessionId),
    uploaderDeviceIdx: index('session_attachments_uploader_device_id_idx').on(t.uploaderDeviceId),
  }),
);

export const sessionAttachmentsRelations = relations(sessionAttachments, ({ one }) => ({
  session: one(agentSessions, {
    fields: [sessionAttachments.sessionId],
    references: [agentSessions.id],
  }),
  uploader: one(users, { fields: [sessionAttachments.uploaderId], references: [users.id] }),
  uploaderDevice: one(devices, {
    fields: [sessionAttachments.uploaderDeviceId],
    references: [devices.id],
  }),
}));

export const appConfig = pgTable('app_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  chatProviderId: text('chat_provider_id'),
  chatModel: text('chat_model'),
  /** `{ [ChatTurnKind]: model }` — a per-kind model on the same provider; a missing kind falls to `chatModel`. */
  chatModelByKind: jsonb('chat_model_by_kind').notNull().default(sql`'{}'::jsonb`),
  retrievalRerank: boolean('retrieval_rerank').notNull().default(false),
  retrievalExpandRelations: boolean('retrieval_expand_relations').notNull().default(false),
  systemPromptOverride: text('system_prompt_override'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appConfigRelations = relations(appConfig, ({ one }) => ({
  project: one(projects, { fields: [appConfig.projectId], references: [projects.id] }),
}));

// v1 EPIC 5 (ISS-274) — append-only retrieval log. Today only `/api/memory/search`
// (`source='api-search'`) populates this; EPIC 1's chat-prompt-builder will add
// `source='chat'` rows. No retention sweep yet — see ISS-274 plan Risks.
export const retrievalSources = ['api-search', 'chat'] as const;
export type RetrievalSource = (typeof retrievalSources)[number];

export const retrievalAnalytics = pgTable(
  'retrieval_analytics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    hitCount: integer('hit_count').notNull(),
    topScore: real('top_score'),
    model: text('model'),
    durationMs: integer('duration_ms'),
    source: text('source', { enum: retrievalSources }).notNull().default('api-search'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index('retrieval_analytics_project_created_idx').on(
      t.projectId,
      t.createdAt,
    ),
  }),
);

export const retrievalAnalyticsRelations = relations(retrievalAnalytics, ({ one }) => ({
  project: one(projects, { fields: [retrievalAnalytics.projectId], references: [projects.id] }),
}));

export const issueDependencyKinds = [
  'blocks',
  'relates',
  'duplicates',
  'parent',
  'decomposes',
] as const;
export type IssueDependencyKind = (typeof issueDependencyKinds)[number];

export const issueDependencies = pgTable(
  'issue_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromIssueId: uuid('from_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    toIssueId: uuid('to_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: issueDependencyKinds }).notNull(),
    reason: text('reason'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
  },
  (t) => ({
    uniqueEdgeIdx: uniqueIndex('issue_dependencies_unique_edge_idx').on(
      t.projectId,
      t.fromIssueId,
      t.toIssueId,
      t.kind,
    ),
    projectFromIdx: index('issue_dependencies_project_from_idx').on(t.projectId, t.fromIssueId),
    projectToIdx: index('issue_dependencies_project_to_idx').on(t.projectId, t.toIssueId),
  }),
);

export const issueDependenciesRelations = relations(issueDependencies, ({ one }) => ({
  project: one(projects, {
    fields: [issueDependencies.projectId],
    references: [projects.id],
  }),
  fromIssue: one(issues, {
    fields: [issueDependencies.fromIssueId],
    references: [issues.id],
    relationName: 'issueDependenciesFrom',
  }),
  toIssue: one(issues, {
    fields: [issueDependencies.toIssueId],
    references: [issues.id],
    relationName: 'issueDependenciesTo',
  }),
  createdBy: one(users, {
    fields: [issueDependencies.createdById],
    references: [users.id],
  }),
}));

// ISS-234 — Integration Framework foundation. secrets_enc columns hold the
// AES-256-GCM ciphertext produced by src/integrations/vault.ts; the legacy
// project_integrations table was retired by ISS-410 (epic ISS-404, F5) in
// favour of the integration_connections / integration_bindings model below.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

import * as ints from './schema-integration-types.js';

export * from './schema-integration-types.js';

export const integrationDeliveries = pgTable(
  'integration_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingId: uuid('binding_id').references(() => integrationBindings.id, {
      onDelete: 'cascade',
    }),
    direction: text('direction', { enum: ints.integrationDeliveryDirections }).notNull(),
    eventName: text('event_name').notNull(),
    requestId: text('request_id'),
    status: text('status', { enum: ints.integrationDeliveryStatuses }).notNull().default('pending'),
    payload: jsonb('payload').notNull().default({}),
    response: jsonb('response'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    bindingCreatedIdx: index('integration_deliveries_binding_created_idx').on(
      t.bindingId,
      sql`${t.createdAt} DESC`,
    ),
    // A dispatch keyed by (binding, requestId) is deduped at the database.
    bindingRequestIdUq: uniqueIndex('integration_deliveries_binding_request_id_uq')
      .on(t.bindingId, t.requestId)
      .where(sql`request_id IS NOT NULL`),
  }),
);

export const integrationDeliveriesRelations = relations(integrationDeliveries, ({ one }) => ({
  binding: one(integrationBindings, {
    fields: [integrationDeliveries.bindingId],
    references: [integrationBindings.id],
  }),
}));

// Additive successor to project_integrations: the CREDENTIAL (connection, owned
// by a principal — user now, org later) is split from the per-project LINK
// (binding). Tables land empty+backfilled; all current read/dispatch paths keep
// using project_integrations until the REST cutover issue flips them. Owner is a
// generic principal so org-level sharing arrives without a data migration.

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Generic principal. ownerType discriminates the namespace of ownerId so we
    // can add 'org' later without re-keying rows; no FK because it is polymorphic.
    ownerType: text('owner_type', { enum: ints.integrationOwnerTypes }).notNull().default('user'),
    ownerId: uuid('owner_id').notNull(),
    provider: text('provider').notNull(),
    displayName: text('display_name'),
    // Connection-scoped non-secret config (e.g. coolify baseUrl, epodsystem
    // store identity). Per-project overrides live on the
    // binding.
    config: jsonb('config').notNull().default({}),
    // The ONE encrypted copy of the credential — rotate once, every binding
    // follows. Same <iv:12><tag:16><ct> format as project_integrations.
    secretsEnc: bytea('secrets_enc'),
    // Future OAuth-first connect (GitHub App installation id, etc.).
    oauthInstallationId: text('oauth_installation_id'),
    active: boolean('active').notNull().default(true),
    breakerOpenedAt: timestamp('breaker_opened_at', { withTimezone: true }),
    lastHealthStatus: text('last_health_status'),
    lastHealthDetail: text('last_health_detail'),
    lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
    inboundEndpointObserved: jsonb('inbound_endpoint_observed').$type<ints.ObservedEndpoint>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerProviderIdx: index('integration_connections_owner_provider_idx').on(
      t.ownerType,
      t.ownerId,
      t.provider,
    ),
    activeProviderIdx: index('integration_connections_active_provider_idx')
      .on(t.provider, t.active)
      .where(sql`active = true`),
  }),
);

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

export const integrationConnectionsRelations = relations(integrationConnections, ({ many }) => ({
  bindings: many(integrationBindings),
}));

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

/**
 * Short-lived, single-use capability tickets for out-of-band attachment uploads
 * (the presigned-URL pattern). `POST /api/conversations/:id/attachments` mints
 * a row; the holder PUTs file bytes to /api/uploads/:id with no bearer — possession of the unguessable id +
 * not-expired + not-consumed IS the authorization. All upload params are stored
 * server-side here so the URL cannot be tampered with.
 */
export const uploadTickets = pgTable(
  'upload_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    uploaderDeviceId: uuid('uploader_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    maxBytes: integer('max_bytes').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetIdx: index('upload_tickets_target_idx').on(t.targetType, t.targetId),
    expiresIdx: index('upload_tickets_expires_at_idx').on(t.expiresAt),
  }),
);

/**
 * Per-issue per-pipeline-run structured context (proposal Y).
 *
 * Stores the typed payload an agent writes at the end of a pipeline step
 * (kind='handoff') so the next state's prompt can inject it instead of
 * re-fetching the raw issue description / plan. Generic `kind` discriminator
 * leaves room for future per-issue per-run artifacts (blocker notes,
 * retrospectives, cross-step decisions) without another table.
 *
 * Lifecycle is fully derived: cascade delete from issues OR pipeline_runs.
 * No embedding here — handoffs are queried by natural key
 * `(issue_id, step, attempt)` in the hot path, not by similarity.
 *
 * Partial unique constraint enforces (issue, step, attempt) uniqueness for
 * `kind='handoff'` rows only; future kinds can have multiple rows per
 * (issue, step, attempt) without contention.
 */
export const issueStepContextKinds = ['handoff'] as const;
export type IssueStepContextKind = (typeof issueStepContextKinds)[number];

export const testResults = ['pass', 'fail', 'blocked_fixture', 'verified_by_test'] as const;
export const stepVerdicts = [...testResults, 'needs_fix', 'no_change', 'abstain'] as const;
export type StepVerdict = (typeof stepVerdicts)[number];

export const issueStepContexts = pgTable(
  'issue_step_contexts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references((): AnyPgColumn => issues.id, { onDelete: 'cascade' }),
    pipelineRunId: uuid('pipeline_run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    step: text('step'),
    attempt: integer('attempt').notNull().default(1),
    payload: jsonb('payload').notNull(),
    // ISS-381 (2.1) — nullable; set only for review/test handoffs. Powers the
    // pass_rate / approve_rate timeseries reads (migration 0094).
    verdict: text('verdict', { enum: stepVerdicts }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    handoffUq: uniqueIndex('issue_step_contexts_handoff_uq')
      .on(t.issueId, t.step, t.attempt)
      .where(sql`${t.kind} = 'handoff'`),
    issueKindIdx: index('issue_step_contexts_issue_kind_idx').on(t.issueId, t.kind),
    runIdx: index('issue_step_contexts_run_idx').on(t.pipelineRunId),
    verdictIdx: index('issue_step_contexts_verdict_idx')
      .on(t.projectId, t.step, t.createdAt)
      .where(sql`${t.verdict} IS NOT NULL`),
  }),
);

// ISS-381 (2.2) — per-project queue-depth snapshots written once per pipeline
// sweeper tick (runPipelineSweep) for projects with active jobs. Sparse: a tick
// with no active jobs for a project writes no row; the read gap-fills as 0.
export const queueSnapshots = pgTable(
  'queue_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    queueDepth: integer('queue_depth').notNull(),
    runningCount: integer('running_count').notNull(),
    avgWaitMs: bigint('avg_wait_ms', { mode: 'number' }),
  },
  (t) => ({
    projectTsIdx: index('queue_snapshots_project_ts_idx').on(t.projectId, t.ts),
  }),
);

// ISS-381 (2.3) — runner status-change audit, one row per transition written by
// `runners/runner-events.ts:setRunnerStatus`, so it records what was DECIDED
// about a runner and never an actor of `runners.status`. old_status is
// nullable for the initial bind/create event.
export const runnerEvents = pgTable(
  'runner_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runnerId: uuid('runner_id')
      .notNull()
      .references((): AnyPgColumn => runners.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    oldStatus: text('old_status'),
    newStatus: text('new_status').notNull(),
    reason: text('reason'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runnerTsIdx: index('runner_events_runner_ts_idx').on(t.runnerId, t.ts),
    projectTsIdx: index('runner_events_project_ts_idx').on(t.projectId, t.ts),
  }),
);

export * from './schema-agent-reports.js';

export const integrationGuides = pgTable(
  'integration_guides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgProviderUq: uniqueIndex('integration_guides_org_provider_uq').on(t.orgId, t.provider),
  }),
);

export const integrationGuidesRelations = relations(integrationGuides, ({ one }) => ({
  org: one(organizations, {
    fields: [integrationGuides.orgId],
    references: [organizations.id],
  }),
}));

export const downloadTickets = pgTable(
  'download_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetType: text('target_type').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issuedToUserId: uuid('issued_to_user_id').references(() => users.id, { onDelete: 'set null' }),
    issuedToDeviceId: uuid('issued_to_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    fetchCount: integer('fetch_count').notNull().default(0),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    attachmentIdx: index('download_tickets_attachment_idx').on(t.targetType, t.attachmentId),
    expiresIdx: index('download_tickets_expires_at_idx').on(t.expiresAt),
  }),
);

export const attributeValueTypes = [
  'text',
  'number',
  'bool',
  'timestamp',
  'ref_issue',
  'ref_user',
  'ref_comment',
] as const;
export type AttributeValueType = (typeof attributeValueTypes)[number];

export const attributeWriters = ['agent', 'human'] as const;
export type AttributeWriter = (typeof attributeWriters)[number];

export const attributeCardinalities = ['one', 'many'] as const;

export const issueAttributeDefs = pgTable('issue_attribute_defs', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  valueType: text('value_type').notNull(),
  cardinality: text('cardinality').notNull().default('one'),
  writtenBy: text('written_by').notNull(),
  surfaces: jsonb('surfaces').notNull().default([]),
  required: boolean('required').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const issueAttributes = pgTable(
  'issue_attributes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    key: text('key')
      .notNull()
      .references(() => issueAttributeDefs.key, { onDelete: 'cascade' }),
    valueText: text('value_text'),
    valueNum: doublePrecision('value_num'),
    valueBool: boolean('value_bool'),
    valueTs: timestamp('value_ts', { withTimezone: true }),
    valueRef: uuid('value_ref'),
    sourceCommentId: uuid('source_comment_id').references(() => comments.id, {
      onDelete: 'set null',
    }),
    assertedByUserId: uuid('asserted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assertedAt: timestamp('asserted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueKeyIdx: index('issue_attributes_issue_key_idx').on(t.issueId, t.key),
    refIdx: index('issue_attributes_ref_idx').on(t.valueRef),
  }),
);

export const issueAttributesRelations = relations(issueAttributes, ({ one }) => ({
  issue: one(issues, { fields: [issueAttributes.issueId], references: [issues.id] }),
  def: one(issueAttributeDefs, {
    fields: [issueAttributes.key],
    references: [issueAttributeDefs.key],
  }),
}));
