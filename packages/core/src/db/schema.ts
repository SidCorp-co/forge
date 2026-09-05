import { relations, type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { identSearchColumn, MEMORY_EMBEDDING_DIM, pgVector, tsVector } from './schema-types.js';

export { MEMORY_EMBEDDING_DIM, pgVector, tsVector } from './schema-types.js';

import { BODY_FORMATS } from '../body/formats.js';
import type { IssueBranchOverride } from '../branches/resolve.js';
import type { ReleaseNotes } from '../issues/release-notes.js';
import { FAILURE_CAUSES, type FailureCause } from '../pipeline/failure-causes.js';
import { activityLog } from './schema-activity.js';

// cm:edge naming -> packages/core/src/db/schema-activity.ts — re-exported so that `activity_log` moving out of this file is invisible to its ten importers. Drop this line and every one of them breaks at once; that is the only reason it is here, not a licence to grow it into a barrel.
export {
  type ActorType,
  activityLog,
  activityLogRelations,
  actorAgencies,
  actorTypes,
} from './schema-activity.js';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
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
    // cm:why text rather than a pg enum so adding a provider ('github' | 'google' | 'oidc' today) is not a migration
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

// cm:guard this is the device-token mint (browser-approved, one per runner install); `pairingCodes` further down is the separate project binding. Folding the two tables together drops the distinction between "this machine may talk to Forge" and "this machine works on that project".
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
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
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

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull().default('system'),
  language: text('language').notNull().default('en'),
  /**
   * False suppresses in-app `mention` notifications (gated in `createNotification`).
   * `mention` is the only user-initiated type produced, so it is the only opt-out
   * offered — no controls for channels that do not exist.
   */
  notifyOnMention: boolean('notify_on_mention').notNull().default(true),
  /**
   * Newest "What's New" entry seen: a changelog version, or `unreleased:<hash>`
   * for the moving [Unreleased] section. The nav badge shows while this differs
   * from the top entry; null means the feed was never opened (ISS-384).
   */
  lastSeenWhatsNew: text('last_seen_whats_new'),
  /**
   * The org being "worked in" (ISS-469). Null means no explicit choice and the
   * client resolves it to the personal org; `set null` on org delete so a removed
   * org clears the pointer rather than blocking the delete or dangling.
   */
  activeOrgId: uuid('active_org_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
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

// cm:guard org role does NOT imply project access on its own: owner/admin derive an implicit project `admin`, plain `member` derives nothing and still needs a `project_members` row. Resolve it through `lib/authz.ts effectiveProjectRole` — a second implementation grants or denies differently and nothing compares the two.

export const orgMemberRoles = ['owner', 'admin', 'member'] as const;
export type OrgMemberRole = (typeof orgMemberRoles)[number];

// Soft "working lens(es)" an org owner/admin assigns to a member — orthogonal to
// the permission `role`. Multi-valued; shapes ONLY how the interactive agent
// answers (altitude/voice), never permissions. Empty = default (product /
// non-technical voice). See prompt/system.ts buildChatPreamble.
export const memberLenses = ['technical', 'product'] as const;
export type MemberLens = (typeof memberLenses)[number];

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    // Personal orgs are auto-created (one per user, partial-unique below),
    // cannot be deleted, and are the default target for project creation.
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
    // Soft working lens(es) — see `memberLenses`. Owner/admin-assigned; values
    // validated at the app layer (route zod), mirroring `apiKeys.scopes`.
    lenses: text('lenses').array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    userIdIdx: index('organization_members_user_id_idx').on(t.userId),
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
    // 'owner' is never invitable — granting owner is an explicit in-app act.
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

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // Audit-only: who created the project. Carries NO authz semantics — the
    // creator is granted a project_members `admin` row at create time and the
    // effective role is always resolved via lib/authz.ts.
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    description: text('description'),
    // ISS-387 — project kind. `standard` = code repo project (default);
    // `website` = an Epodsystem-backed storefront (the store is the source of
    // truth, so a git repo is optional). Free-text column gated by the
    // `projectKinds` app-level enum; default keeps every existing row valid.
    kind: text('kind').notNull().default('standard'),
    repoPath: text('repo_path'),
    baseBranch: text('base_branch'),
    productionBranch: text('production_branch'),
    // Per-project git clone URL (SSH form, e.g. git@github.com:org/repo.git).
    // Optional: when set with a project git credential, a freshly-assigned
    // device auto-clones here during provision; absent => manual folder setup.
    repoUrl: text('repo_url'),
    // cm:guard prose ON PURPOSE, and never executed as a command list: any project admin can write this, and the runner would be running it unreviewed on every box. NULL is not an error — it means the setup agent derives the procedure from the repo itself, at a paid model's rates, on every job that needs it.
    // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/setup_agent.rs — this column plus the live findings ARE that agent's whole prompt
    workspaceSetup: text('workspace_setup'),
    defaultDeviceId: uuid('default_device_id').references((): AnyPgColumn => devices.id, {
      onDelete: 'set null',
    }),
    agentConfig: jsonb('agent_config'),
    previewDeploy: jsonb('preview_deploy'),
    webhookSecret: text('webhook_secret'),
    apiKey: text('api_key'),
    // ISS-353 — soft archive. Nullable: NULL = active, a timestamp = archived.
    // Archived projects are hidden from the default project list and paused
    // from auto-pipeline dispatch; nothing is destroyed (fully restorable).
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdIdx: index('projects_org_id_idx').on(t.orgId),
    createdByIdx: index('projects_created_by_idx').on(t.createdBy),
    apiKeyUq: uniqueIndex('projects_api_key_uq').on(t.apiKey).where(sql`api_key IS NOT NULL`),
    defaultDeviceIdx: index('projects_default_device_id_idx').on(t.defaultDeviceId),
    archivedAtIdx: index('projects_archived_at_idx').on(t.archivedAt),
  }),
);

/** ISS-387 — allowed project kinds. `standard` = code repo project; `website`
 *  = Epodsystem storefront project (git repo optional). */
export const projectKinds = ['standard', 'website'] as const;
export type ProjectKind = (typeof projectKinds)[number];

// Project roles (no `owner` — project "ownership" is an org concern; the org
// owner/admin get implicit project `admin`). `viewer` is read-only.
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
  defaultDevice: one(devices, {
    fields: [projects.defaultDeviceId],
    references: [devices.id],
  }),
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

export const devicePlatforms = ['macos', 'linux', 'windows'] as const;
export type DevicePlatform = (typeof devicePlatforms)[number];

export const deviceStatuses = ['online', 'offline', 'revoked'] as const;
export type DeviceStatus = (typeof deviceStatuses)[number];

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
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 8 }).notNull(),
    status: text('status', { enum: deviceStatuses }).notNull().default('offline'),
    // Operator-set "turn off" switch (reversible, distinct from `revoked`). When
    // set, the device is IGNORED by dispatch + interactive-chat device-pick
    // across EVERY project it runs for — it keeps its token + runner bindings and
    // still heartbeats, so flipping it back (set to NULL) makes it eligible again
    // instantly. NULL = on/eligible. Orthogonal to `status` (heartbeat-driven
    // online/offline), so a steady heartbeat never clears it.
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    pairedAt: timestamp('paired_at', { withTimezone: true }).notNull().defaultNow(),
    capabilities: jsonb('capabilities'),
    // cm:guard chat is NOT counted against this — it runs off the jobs table with its own budget on the runner (`[runner] chat_max_concurrent`) and never takes a `job.assigned` slot, so folding the two together would let a burst of chats starve the pipeline (ISS-321).
    // cm:guard the unit is the DEVICE and must stay there: the resource a job consumes is one Claude process on one machine, so a box bound to 20 projects at cap 3 runs 3 jobs total, not 3 per project. It is compared against `countInFlightForDevice`, never against the per-binding count that feeds the load reports.
    // cm:guard NOTHING IN CORE READS THIS. How many jobs a box may hold is the runner's decision (`[runner] duplex_max_sessions`, RAM, the repo-root lock in `daemon/repo_lock.rs`), and core deliberately stopped having an opinion when the master began claiming from the pool — `devices/claim.ts` carries the guard saying why. Wiring a reader back onto this column re-introduces the kernel ceiling that design removed, and a ceiling core cannot see the real value of can only be wrong.
    maxConcurrent: integer('max_concurrent').notNull().default(1),
    // ISS-305 — non-secret label recording that a git push credential was
    // auto-provisioned for this device at login time (e.g. 'https-helper' or
    // 'ssh-deploy-key'); NULL means no credential was provisioned. The secret
    // material itself is returned once at poll time and never stored here.
    gitCredentialRef: text('git_credential_ref'),
    // Stable per-machine identity (sha256 hex of the host's /etc/machine-id),
    // sent by the runner at pairing. Lets a re-pair from the same machine
    // rotate the EXISTING device row in place (keeping its runner bindings)
    // instead of inserting a duplicate "ghost" device. NULL for legacy clients
    // that don't send one → pairing falls back to always-insert.
    machineId: text('machine_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdIdx: index('devices_owner_id_idx').on(t.ownerId),
    tokenPrefixIdx: index('devices_token_prefix_idx').on(t.tokenPrefix),
    ownerMachineIdx: index('devices_owner_machine_idx').on(t.ownerId, t.machineId),
  }),
);

// ISS-150 — Personal Access Tokens (PAT) for non-device MCP clients
// (Cursor, Cline, Zed, web-only users). Mints + verification live in
// packages/core/src/auth/pat.ts.
export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    // `forge_pat_<env>_<4 hex>` — 18 chars, indexed for fast lookup.
    tokenPrefix: varchar('token_prefix', { length: 18 }).notNull(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY['read','write']::text[]`),
    // NULL = inherit user's project memberships (global PAT). Non-null = strict allowlist.
    projectIds: uuid('project_ids').array(),
    // ISS-497 — project-level token: NULL = user-level (today's behavior, zero backfill);
    // set = bound to exactly this project (slug-omitted default AND auth fence).
    boundProjectId: uuid('bound_project_id').references(() => projects.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // null = use RULES.patPerToken default; otherwise per-token override.
    rateLimitMax: integer('rate_limit_max'),
  },
  (t) => ({
    userNameUq: uniqueIndex('pat_user_name_uniq').on(t.userId, t.name),
    userActiveIdx: index('pat_user_active_idx').on(t.userId, t.revokedAt),
    tokenPrefixIdx: index('pat_token_prefix_idx').on(t.tokenPrefix),
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
    // 'ok' | 'forbidden' | 'not_found' | 'error' | 'revoked' | 'rate_limited' | http code
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
    // Nullable — user-scoped pairing codes leave this null. Set when the code
    // is minted via `POST /api/projects/:id/devices/pairing-codes` so the
    // redeemer can auto-bind the new device to the project.
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
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

// cm:guard `held` is NON-TERMINAL and slotless — a job blocked on a mechanical condition (no runner, provider quota, project budget) waits HERE, never on issues.status (RFC 0002); being absent from runner_load/running_ids is exactly what makes it slotless, but it MUST appear in both `jobs_active_unique` partial indexes below and in L1 issueBusyJob or a duplicate job is enqueued for the same issue
// cm:edge lockstep -> packages/core/src/jobs/queued-gates.ts — `issueBusyJob` must list `held`; `runner_load` and `running_ids` must NOT
export const jobStatuses = [
  'queued',
  'dispatched',
  'running',
  'held',
  'done',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobTypes = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  // Canonical staging-deploy step (status `pass` → deploy to the staging/preview
  // env, advance to `staging`). jobType `staging` keeps the forge-${jobType}
  // convention (skill `forge-staging`, which already exists). `staging` the
  // ISSUE STATUS stays a no-step approval gate — distinct enum from this jobType.
  'staging',
  'release',
  'fix',
  'custom',
  'pm',
  // ISS-455 — skill smoke-verify canary (tier-2). Issue-less one-shot job on a
  // 'system' pipeline_run; PASS/FAIL is read from the job's terminal status
  // (which still flips only via applyKernelTransition, like every job).
  'smoke',
  // cm:edge naming -> packages/core/src/release-batch/service.ts — a release_batch job's run has metadata.source==='release-batch', not type-checked
  'release_batch',
  'reconcile',
  'verify_skill',
  'drive',
] as const;
export type JobType = (typeof jobTypes)[number];

export const modelTiers = ['haiku', 'sonnet', 'opus'] as const;
export type ModelTier = (typeof modelTiers)[number];

// ISS-101 — pipeline_runs groups every job/agent_session of a single
// pipeline walk. Picker orders by `(priority, run.started_at, queued_at)`
// so all jobs of the oldest run drain before a newer same-priority run.
// `kind` discriminates issue-driven pipelines from one-shot PM jobs and
// interactive chat sessions (both keep `issueId` NULL so the NOT NULL FK
// on `jobs`/`agent_sessions` always has a row to point at).
// 'system' covers one-shot project-scoped jobs without an issueId — schedule
// runs, skill pushes, MCP/CLI custom jobs. Kept distinct from 'pm' (PM
// coordinator) so reviews of pipeline_runs.kind aren't ambiguous.
export const pipelineRunKinds = ['issue', 'pm', 'interactive', 'system'] as const;
export type PipelineRunKind = (typeof pipelineRunKinds)[number];

export const pipelineRunStatuses = [
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectStatusIdx: index('pipeline_runs_project_status_idx').on(t.projectId, t.status),
    issueIdx: index('pipeline_runs_issue_idx').on(t.issueId),
    projectStartedAtIdx: index('pipeline_runs_started_at_idx').on(t.projectId, t.startedAt),
    // Mirror of the partial unique index in 0054 — at most one open issue-run
    // per issue. Lets `openIssueRun` use INSERT ... ON CONFLICT DO NOTHING.
    issueOpenUq: uniqueIndex('pipeline_runs_issue_open_uq')
      .on(t.issueId)
      .where(sql`kind = 'issue' AND status IN ('running','paused')`),
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
    // ISS-101 — every job belongs to a pipeline_run. Issue-driven jobs share
    // the issue's run; PM jobs get a one-shot 'pm' run each. NOT NULL is
    // enforced at the DB level by migration 0054.
    pipelineRunId: uuid('pipeline_run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    // EPIC 2 (ISS-271): nullable runner FK. The dispatcher writes both
    // deviceId and runnerId on dispatch; device-bound runners mirror
    // runner.deviceId here, remote runners leave it null.
    runnerId: uuid('runner_id').references((): AnyPgColumn => runners.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text('type', { enum: jobTypes }).notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status', { enum: jobStatuses }).notNull().default('queued'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    // ISS-449 (ISS-442 C3 / I3) — runner ACK: stamped when the runner
    // explicitly claims the job (POST /jobs/:id/ack) or, as fallback, when its
    // first job_event arrives. The loop monitor's dispatch→ack hop reaps
    // dispatched rows that never get one.
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    error: text('error'),
    modelTier: text('model_tier', { enum: modelTiers }),
    attempts: integer('attempts').notNull().default(1),
    cancellationRequested: boolean('cancellation_requested').notNull().default(false),
    // cm:guard never conflate with cancellationRequested — a reap kill must stay retryable once confirmed, unlike an operator cancel
    // cm:edge contract -> packages/core/src/jobs/retry.ts — scheduleAutoRetryWithVerify short-circuits retry on cancellationRequested, not on killRequestedAt/killOutcome
    killRequestedAt: timestamp('kill_requested_at', { withTimezone: true }),
    killConfirmedAt: timestamp('kill_confirmed_at', { withTimezone: true }),
    // cm:why plain text (no pg enum) — adding an outcome value is additive, no migration
    killOutcome: text('kill_outcome', {
      enum: ['killed', 'not_found', 'runner_gone', 'reported_terminal', 'never_claimed'],
    }),
    retryOf: uuid('retry_of').references((): AnyPgColumn => jobs.id, { onDelete: 'set null' }),
    // ISS-197 — when set, dispatch gate L1 skips this row until now() >=
    // retry_after_at. Written by the retry engine after a transient/timeout
    // failure with an optional provider Retry-After hint; NULL otherwise.
    retryAfterAt: timestamp('retry_after_at', { withTimezone: true }),
    // ISS-4: link to the observability `agent_sessions` row created by the
    // dispatcher so /pipeline + issue detail surfaces can render pipeline
    // jobs alongside interactive sessions. Bare uuid (no FK) to match the
    // notifications.agent_session_id pattern — adding the FK later is additive.
    agentSessionId: uuid('agent_session_id'),
    // cm:guard the master session holding this job. NULL means claimable; non-NULL means a master took it and is answerable for it. It MUST be released when that session dies — `devices/master-reaper.ts` is what does that, and without it a dead master's jobs are unclaimable forever with nothing reporting why.
    // cm:edge lockstep -> packages/core/src/devices/pool.ts — `held_by IS NULL` is the pool's only exclusion, so a writer that sets this column without a matching release path silently shrinks the pool
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
    // cm:why ISS-823 — NULL on pre-existing rows; retry.ts falls back to deriveActionFromKind(failureKind) so historical behaviour is unchanged
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
    // cm:why runner-observed hashes at ACK time (job.ran.with), not intended — null for pre-0.7.0 runners or unseeded jobs
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
    // cm:why partial index keeps the kill-gate phase-2 scan off the hot unfiltered jobs table
    killRequestedAtIdx: index('jobs_kill_requested_at_idx')
      .on(t.status, t.killRequestedAt)
      .where(sql`kill_requested_at IS NOT NULL`),
    activeUniqueIdx: uniqueIndex('jobs_active_unique')
      .on(t.issueId, t.type)
      .where(sql`status IN ('queued','dispatched','running','held') AND issue_id IS NOT NULL`),
    // PM jobs may have a NULL issue_id (project-scoped coordinator), so the
    // existing per-issue index does not cover them. ISS-17.
    pmActiveUniqueIdx: uniqueIndex('jobs_pm_per_project_unique_idx')
      .on(t.projectId)
      .where(sql`type = 'pm' AND status IN ('queued','dispatched','running','held')`),
    pipelineRunIdx: index('jobs_pipeline_run_idx').on(t.pipelineRunId),
    finishedArchiveIdx: index('jobs_finished_archive_idx')
      .on(t.finishedAt)
      .where(sql`archive_path IS NULL AND finished_at IS NOT NULL`),
    // ISS-455 — the smoke-verify report reads "latest canary per stage" for a
    // project; the partial index keeps that read off the hot jobs rows.
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

export const jobEventKinds = [
  'stdout',
  'stderr',
  'tool_call',
  'tool_result',
  'progress',
  'result',
  // ISS-442 C0 — audited manual intervention (e.g. single-job cancel). `kind`
  // is a plain text column, so this is additive with no migration; the
  // interventions metric (C6) counts rows with this kind.
  'intervention',
  // cm:why audit row written by POST /jobs/:id/kill-ack (runner's answer to a job.cancel: outcome killed|not_found in data.outcome)
  'kill_ack',
] as const;
export type JobEventKind = (typeof jobEventKinds)[number];

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
  }),
);

// ISS-447 (ISS-442 C1, I2) — append-only audit of every TERMINAL status flip on
// the three kernel tables (jobs / agent_sessions / pipeline_runs). Written by
// the single chokepoint `lifecycle/transition.ts:applyKernelTransition`; one row
// per flipped entity per transition. Queryable so the C6 interventions /
// throughput metrics can count transitions by entity/reason/source without
// scraping logs. `from_status` is the declared prior status (the CAS guard's
// expected value); `actor_id` is a bare uuid (no FK) so a system/sweeper actor
// with no principal records NULL without a join target.
export const kernelTransitionEntities = ['job', 'session', 'run'] as const;
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
    reason: text('reason'),
    actorType: text('actor_type', { enum: kernelTransitionActorTypes }).notNull(),
    actorId: uuid('actor_id'),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('kernel_transitions_entity_idx').on(t.entity, t.entityId),
    createdAtIdx: index('kernel_transitions_created_at_idx').on(t.createdAt),
    reasonIdx: index('kernel_transitions_reason_idx').on(t.reason),
  }),
);

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

export const runnerStatuses = ['online', 'offline', 'draining', 'disabled'] as const;

// Why a runner is currently limited/errored, surfaced in the UI as a distinct
// "limited" health state (ported from forge-agents device-disable handling).
// `usage_limit` / `rate_limit` are time-based (carry `rateLimitedUntil`);
// `auth` (401 invalid credentials) needs operator intervention so it has no
// reset time — it clears only on the next healthy heartbeat / a successful job.
export const runnerLimitReasons = ['usage_limit', 'rate_limit', 'auth'] as const;
export type RunnerLimitReason = (typeof runnerLimitReasons)[number];

// Per (device × project) workspace provisioning lifecycle. `queued` waits for an
// offline device; the runner walks cloning → syncing_skills → writing_mcp →
// ready. `needs_manual_setup` is the graceful degrade when there's no clone URL/
// key and the folder is missing (user sets it up by hand); `failed` is an error.
export const runnerProvisionStatuses = [
  'queued',
  'cloning',
  'syncing_skills',
  'writing_mcp',
  'ready',
  'needs_manual_setup',
  'failed',
] as const;
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
    // cm:guard every runner is a binding of a REAL paired device: the `host='remote'` lane and its `device_id IS NULL` rows were deleted 2026-09-04, so a null device is not a second shape to handle, it is corruption. Selection, dispatch and the limit scope all join through this column; leaving it nullable is what let those joins silently drop rows instead of failing.
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    labels: jsonb('labels').notNull().default([]),
    capabilities: jsonb('capabilities').notNull().default({}),
    config: jsonb('config').notNull().default({}),
    // ISS-271 — per (device × project) repo checkout. Source of truth for the
    // runner working dir, written by web (PATCH) or CLI (`forge-runner bind`).
    // `projects.repoPath` is now only a default hint when binding a new device.
    repoPath: text('repo_path'),
    branch: text('branch'),
    status: text('status', { enum: runnerStatuses }).notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastError: text('last_error'),
    // cm:why rateLimitedUntil is NULL for reason='auth' (no parseable reset — needs a manual re-login); a non-null limitReason with a future rateLimitedUntil is the dispatcher's skip signal and the UI's "limited" badge source
    // cm:edge sideeffect -> packages/core/src/agent-sessions/routes.ts — chat session completion also clears these fields, not only job lifecycle
    limitReason: text('limit_reason', { enum: runnerLimitReasons }),
    rateLimitedUntil: timestamp('rate_limited_until', { withTimezone: true }),
    limitDetail: text('limit_detail'),
    // cm:why durable hard-exclusion alongside rateLimitedUntil so it survives a retry round wrapping (the rotation clears its exclude set there); self-heals on expiry, cleared on the next success
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

// cm:guard the two kinds are AUTHORED, never derived (RFC 0002 INV-5) — an agent or a human writes one alongside `status='waiting'`, and core has no writer of either. Adding a third kind means teaching the prompt, the guide and the UI copy in the same change, or agents author a value nothing renders.
export const waitingKinds = ['needs_decision', 'needs_resource'] as const;
export type WaitingKind = (typeof waitingKinds)[number];

// cm:edge lockstep -> packages/web-v2/src/features/issues/derive.ts — STATUS_LABELS and STATUS_TO_STAGE are exhaustive `Record<IssueStatus, …>`, so a value added here without them fails the web-v2 build, which `pnpm verify` does not run (only CI's `web` job does): `dropped` reached a deploy through the same hole in the desktop map on 2026-08-20, before that client was deleted
export const issueStatuses = [
  'open',
  'confirmed',
  'clarified',
  'waiting',
  'approved',
  'in_progress',
  'developed',
  'testing',
  'tested',
  'released',
  'closed',
  'reopen',
  'on_hold',
  'needs_info',
  'draft',
  'dropped',
] as const;
// cm:why `pass`, `staging` and `deploying` are absent because one-shot migrations re-parked every row off them, so no row can hold them again. The block that used to sit here also called `tested` "the single production approval gate", which ISS-897 falsified — the gate is derived from the project (an active `prod` binding AND a production branch distinct from the base), and `release-batch/gate.ts` is where it is decided.
export type IssueStatus = (typeof issueStatuses)[number];

export const issuePriorities = ['critical', 'high', 'medium', 'low', 'none'] as const;
export type IssuePriority = (typeof issuePriorities)[number];

// ISS-42 C2 — t-shirt sizing for issue scope. Mirrored by the
// `issues_complexity_chk` CHECK constraint (migration 0046). NULL means
// "not yet sized".
export const issueComplexities = ['xs', 's', 'm', 'l', 'xl'] as const;
export type IssueComplexity = (typeof issueComplexities)[number];

export const issueSources = ['manual', 'github'] as const;
export type IssueSource = (typeof issueSources)[number];

// cm:why NEW column, not reused reportedBy — reportedBy is client-writable free text, so it can't carry a trusted label
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
    // cm:why named `description_*` rather than a bare `format`/`template` (ISS-898) — `plan` and `acceptanceCriteria` sit in this same table, so an unqualified name would read as covering all three the moment one of them gains a format
    descriptionFormat: text('description_format', { enum: BODY_FORMATS })
      .notNull()
      .default('markdown'),
    descriptionTemplate: text('description_template'),
    status: text('status', { enum: issueStatuses }).notNull().default('open'),
    priority: text('priority', { enum: issuePriorities }).notNull().default('medium'),
    category: text('category'),
    // Set by webhook/MCP imports; NULL when `createdById` covers the actor.
    reportedBy: text('reported_by'),
    // cm:guard never expose as client-settable on issueCreateSchema or the MCP create input
    createdVia: text('created_via', { enum: issueCreationChannels }),
    // cm:guard at most one non-closed issue may carry a given detector key per project — enforced by partial unique index `issues_detector_key_live_uq` (migration 0158); claimDetectorKey() is the graceful path, the index is the backstop, do not drop it
    detectorKey: text('detector_key'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // cm:guard ISS-232 — this is the Layer-2 dependency gate: NULL means the blocker has not landed, so every `kind=blocks` dependent stays ungated by the picker. It is CALLER-ASSERTED (`issues/merged-at.ts`, `POST /api/issues/:id/merge`, and the close stamp) — nothing checks git — so stamping it on an issue whose code never merged dispatches its dependents against absent code. The old comment here named `pipelineConfig.mergeStates.baseBranch`, a key ISS-897 deleted.
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    // ISS-42 C2 — t-shirt sizing (xs/s/m/l/xl) for scoping. NULL = unsized.
    complexity: text('complexity', { enum: issueComplexities }),
    reopenCount: integer('reopen_count').notNull().default(0),
    // cm:edge lockstep -> packages/core/src/issues/apply-transition.ts — set on entry to `waiting` and CLEARED on every exit; a stale kind on a non-waiting issue is a lie the UI renders as a live banner
    waitingKind: text('waiting_kind', { enum: waitingKinds }),
    source: text('source', { enum: issueSources }).notNull().default('manual'),
    externalId: text('external_id'),
    // ISS-293: extension fields used by the autonomous /forge-* skill pipeline
    // (forge-plan writes plan, forge-clarify reads acceptanceCriteria, etc.).
    // Migration 0031.
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
    // cm:guard claim release_batch_run_id only via the CAS UPDATE (WHERE release_batch_run_id IS NULL) in release-batch/service.ts — never write it directly
    releaseBatchRunId: uuid('release_batch_run_id').references(() => pipelineRuns.id, {
      onDelete: 'set null',
    }),
    identSearch: identSearchColumn(
      (): SQL => sql`left(${issues.title} || ' ' || coalesce(${issues.description}, ''), 100000)`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // cm:guard the sibling of `comments_format_chk`, for the same reason: `text(..., { enum })` is a TypeScript type and emits no constraint, so without this the column accepts any string and `create-service` is the only thing standing between a caller and a format no renderer knows
    descriptionFormatChk: check(
      'issues_description_format_chk',
      sql`${t.descriptionFormat} IN ('markdown', 'html')`,
    ),
    projectIssSeqUq: uniqueIndex('issues_project_iss_seq_uq').on(t.projectId, t.issSeq),
    projectStatusIdx: index('issues_project_status_idx').on(t.projectId, t.status),
    assigneeIdx: index('issues_assignee_idx').on(t.assigneeId),
    projectSourceExternalIdUq: uniqueIndex('issues_project_source_external_id_uq')
      .on(t.projectId, t.source, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    identSearchIdx: index('issues_ident_search_idx').using('gin', t.identSearch),
    releaseBatchRunIdIdx: index('issues_release_batch_run_id_idx')
      .on(t.releaseBatchRunId)
      .where(sql`release_batch_run_id IS NOT NULL`),
  }),
);

export const projectWebhooks = pgTable(
  'project_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    events: text('events').array().notNull().default(sql`ARRAY['issue.statusChanged']::text[]`),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdx: index('project_webhooks_project_id_idx').on(t.projectId),
  }),
);

export const projectWebhooksRelations = relations(projectWebhooks, ({ one }) => ({
  project: one(projects, { fields: [projectWebhooks.projectId], references: [projects.id] }),
}));

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // ISS-519 — agent-authored marker. The authorId FK always points at the
    // device's human owner (NOT-NULL FK to users), so it cannot tell an agent
    // comment apart from one the owner wrote by hand. A non-null
    // authorDeviceId is the authoritative "this was posted by an agent/device"
    // signal; the human REST path leaves it null. `set null` on device delete
    // de-marks the comment back to its owner rather than blocking the delete.
    authorDeviceId: uuid('author_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    // cm:edge contract -> packages/core/src/body/prepare.ts — ISS-898. `format` decides which renderer and which validator a body gets, and its DEFAULT is load-bearing: every pre-existing row and every shipped SKILL.md example omits it, so `markdown` is what keeps them all valid. `template` is the root component name, replacing the regex guess in web-v2 `features/issues/derive.ts:deriveCommentKind`.
    format: text('format', { enum: BODY_FORMATS }).notNull().default('markdown'),
    template: text('template'),
    parentId: uuid('parent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // cm:guard the CHECK is the backstop, not a duplicate of the TS enum: `text(..., { enum })` is a compile-time type only and emits no constraint, so the ~17 kernel paths that `db.insert(comments)` without going through `prepareBody` have nothing else stopping an unrenderable format. Same reason `issues_complexity_chk` exists.
    formatChk: check('comments_format_chk', sql`${t.format} IN ('markdown', 'html')`),
    issueIdx: index('comments_issue_id_idx').on(t.issueId),
    parentIdx: index('comments_parent_id_idx').on(t.parentId),
    parentFk: foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: 'comments_parent_id_fk',
    }).onDelete('cascade'),
  }),
);

// cm:why ISS-593 — a module IS a label rather than a table of its own, so every path that already attaches, filters and lists labels carries modules for free; `kind` is the only thing that separates them.
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
    // cm:guard `text(col,{enum})` with a DEFAULT, matching `issues.status` — the default is load-bearing: every row that existed before ISS-593 and every insert that predates the widened schema must read back as a plain label, never as a module.
    kind: text('kind', { enum: labelKinds }).notNull().default('label'),
    // cm:why modules only — a self-referencing parent gives the taxonomy its hierarchy without a second table. Cycle-freedom is NOT expressible here and is enforced in `labels/module-service.ts`; the FK only guarantees the parent exists.
    parentId: uuid('parent_id').references((): AnyPgColumn => labels.id, { onDelete: 'set null' }),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectNameUq: uniqueIndex('labels_project_id_name_uq').on(t.projectId, t.name),
    parentIdx: index('labels_parent_id_idx').on(t.parentId),
    // cm:guard the CHECK is the backstop, not a duplicate of the TS enum: `text(..., { enum })` is compile-time only and emits no constraint, so any path that inserts a label without going through `labels/routes.ts` can write a kind that is neither — and such a row filters as no module and renders as no label. Same reason `comments_format_chk` and `issues_complexity_chk` exist.
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
    // cm:why ISS-593 — the issue's PRIMARY module, and the single source of truth for it: no column on `issues`, no second table. A plain label is never primary; that half is the service layer's, because SQL cannot see `labels.kind` from this row.
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.labelId] }),
    labelIdx: index('issue_labels_label_id_idx').on(t.labelId),
    // cm:guard the DB backstop for "at most one primary module per issue" — the service layer enforces the same rule with a typed error, and this index is what holds when a writer bypasses it. Partial, so the false rows (all of them, by default) are not indexed.
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
    // cm:why lineage only — which template this copy came from and at which version. Nothing compares the two any more: the rebase lane that did was deleted with the staged pipeline, so a NULL version here is an unknown adoption, not a signal.
    // cm:guard plain uuid, deliberately NO foreign key — deleting a global template must not cascade into the project copies that were adopted from it, which is the whole reason a copy exists.
    basedOnGlobalSkillId: uuid('based_on_global_skill_id'),
    basedOnGlobalVersion: integer('based_on_global_version'),
    // cm:why a deliberate, queryable divergence from the template — the only reason left to record one, now that the version-lag signal it used to suppress is gone with the rebase lane
    pinned: boolean('pinned').notNull().default(false),
    pinnedReason: text('pinned_reason'),
    pinnedBy: text('pinned_by'),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    // When true, a project-scoped skill is synced to device runners (enters the
    // device manifest) even though it is NOT registered to any pipeline stage.
    // Lets a manual / user-invocable utility skill (e.g. forge-product-map) live
    // on the runner without the dispatcher ever auto-running it — stage dispatch
    // keys off skill_registrations, which this flag does not touch.
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

export const skillRegistrations = pgTable(
  'skill_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    registeredBy: uuid('registered_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectStageUq: uniqueIndex('skill_registrations_project_stage_uq').on(t.projectId, t.stage),
    skillIdx: index('skill_registrations_skill_id_idx').on(t.skillId),
  }),
);

// cm:guard `outdated` is derived by comparing installedHash against the project's effective hash (hashSkillBody) — never stored, always recomputed
// cm:guard status is `synced` only when observed_sha equals installed_hash; otherwise shadowed/stale/unknown — never derive synced from installed_hash alone
export const deviceSkills = pgTable(
  'device_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    installedHash: text('installed_hash').notNull(),
    installedVersion: integer('installed_version'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    // cm:why null for pre-0.7.0 runners predating observation support
    observedSha: text('observed_sha'),
    shadowedBy: text('shadowed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    deviceProjectSkillUq: uniqueIndex('device_skills_device_project_skill_uq').on(
      t.deviceId,
      t.projectId,
      t.skillId,
    ),
    deviceProjectIdx: index('device_skills_device_project_idx').on(t.deviceId, t.projectId),
  }),
);

// cm:guard append-only, distinct from `activity_log` above: a poller confirming a hash is unchanged must NOT insert a row here — touch a `last_verified_at` column on the owning skill/device_skills row instead (Update Pipeline §7 principle 1, epic ISS-795).
// cm:why packetId is a plain string with no FK — it correlates one row across all five stages of an Update Packet, whose own table is owned by ISS-799 (not yet built).
export const skillActivityEventTypes = [
  'packet.published',
  'policy.landed',
  'reconcile.started',
  'reconcile.decided',
  'reconcile.failed',
  'skill.body.changed',
  'verify.failed',
  'reconcile.escalated',
  'manifest.changed',
  'device.skill.applied',
  'device.skill.pruned',
  'device.sync.failed',
  'device.skill.observed',
  'device.skill.shadowed',
  'job.ran.with',
  'skill.pinned',
  'charter.changed',
  'reconcile.acknowledged',
] as const;
// cm:why 'body.reverted' removed — no revert action exists to emit it; re-add when one ships.
export type SkillActivityEventType = (typeof skillActivityEventTypes)[number];

export const skillActivityTriggers = [
  'push',
  'poll',
  'cli',
  'provision',
  'deploy',
  'manual',
] as const;
export type SkillActivityTrigger = (typeof skillActivityTriggers)[number];

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
    // cm:why free text, not an enum: `human:<user>` | `agent:master` | `system:seeder` | `runner:<device>`.
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

export const updatePacketIntentClasses = ['invariant', 'procedure', 'enhancement'] as const;
export type UpdatePacketIntentClass = (typeof updatePacketIntentClasses)[number];

export interface UpdatePacketProvenance {
  commit?: string | undefined;
  version?: string | undefined;
  author?: string | undefined;
}

export const updatePackets = pgTable(
  'update_packets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    change: text('change').notNull(),
    // cm:guard a packet with no story must never be issued (Update Pipeline §3) — enforce in createUpdatePacket() too, this CHECK is only the last-resort backstop
    story: text('story').notNull(),
    intentClass: text('intent_class', { enum: updatePacketIntentClasses }).notNull(),
    // cm:why no FK — a packet's target may be a global skill name with no per-project row
    appliesTo: text('applies_to').notNull(),
    provenance: jsonb('provenance').notNull().default({}).$type<UpdatePacketProvenance>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storyNotEmpty: check('update_packets_story_not_empty', sql`length(trim(${t.story})) > 0`),
    createdAtIdx: index('update_packets_created_at_idx').on(t.createdAt),
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
    // cm:guard `chunk_generation` is bumped and `chunked_at` nulled on EVERY write to a chunked-project row, inside the parent upsert's transaction (memory/chunk-writer.ts:invalidateChunks) — the chunk arm of search joins `memory_chunks.generation = chunk_generation` AND `chunked_at IS NOT NULL`, and that join is the only thing keeping a superseded chunk set unreachable when the re-embed of the new text fails (docs/proposals/retrieval-v3-rerank-chunks.md, phase 2)
    chunkGeneration: integer('chunk_generation').notNull().default(0),
    chunkedAt: timestamp('chunked_at', { withTimezone: true }),
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
  }),
);

export const memoryCandidateSignalTypes = [
  'reopen_loop',
  'repeated_fix_type',
  'handoff_gap_rescue',
  'agent_self_report',
] as const;
export type MemoryCandidateSignalType = (typeof memoryCandidateSignalTypes)[number];

export const memoryCandidateStatuses = [
  'accruing',
  'graduated',
  'accepted',
  'rejected',
  'promoted',
] as const;
export type MemoryCandidateStatus = (typeof memoryCandidateStatuses)[number];

export const memoryCandidates = pgTable(
  'memory_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    signalType: text('signal_type', { enum: memoryCandidateSignalTypes }).notNull(),
    signalKey: text('signal_key').notNull(),
    status: text('status', { enum: memoryCandidateStatuses }).notNull().default('accruing'),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('0.30'),
    evidenceCount: integer('evidence_count').notNull().default(1),
    evidence: jsonb('evidence').notNull().default([]),
    summary: text('summary').notNull(),
    graduatedAt: timestamp('graduated_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSignalKeyUq: uniqueIndex('memory_candidates_project_signal_key_uq').on(
      t.projectId,
      t.signalType,
      t.signalKey,
    ),
    projectStatusIdx: index('memory_candidates_project_status_idx').on(t.projectId, t.status),
    archivedIdx: index('memory_candidates_archived_idx').on(t.archivedAt),
  }),
);

export const skillsRelations = relations(skills, ({ one, many }) => ({
  project: one(projects, { fields: [skills.projectId], references: [projects.id] }),
  registrations: many(skillRegistrations),
}));

export const skillRegistrationsRelations = relations(skillRegistrations, ({ one }) => ({
  project: one(projects, { fields: [skillRegistrations.projectId], references: [projects.id] }),
  skill: one(skills, { fields: [skillRegistrations.skillId], references: [skills.id] }),
  registeredByUser: one(users, {
    fields: [skillRegistrations.registeredBy],
    references: [users.id],
  }),
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
  }),
);

export const knowledgeEntriesRelations = relations(knowledgeEntries, ({ one }) => ({
  project: one(projects, { fields: [knowledgeEntries.projectId], references: [projects.id] }),
}));

export const taskStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const taskAgentStatuses = ['idle', 'running', 'completed', 'failed'] as const;
export type TaskAgentStatus = (typeof taskAgentStatuses)[number];

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: taskStatuses }).notNull().default('backlog'),
    priority: text('priority', { enum: issuePriorities }).notNull().default('none'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    isAgentTask: boolean('is_agent_task').notNull().default(false),
    agentStatus: text('agent_status', { enum: taskAgentStatuses }),
    agentLog: jsonb('agent_log'),
    acceptanceCriteria: jsonb('acceptance_criteria'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('tasks_issue_id_idx').on(t.issueId),
    projectStatusIdx: index('tasks_project_status_idx').on(t.projectId, t.status),
    assigneeIdx: index('tasks_assignee_idx').on(t.assigneeId),
    issueSortIdx: index('tasks_issue_sort_idx').on(t.issueId, t.sortOrder),
  }),
);

export const tasksRelations = relations(tasks, ({ one }) => ({
  issue: one(issues, { fields: [tasks.issueId], references: [issues.id] }),
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [tasks.assigneeId], references: [users.id] }),
}));

export const scheduleStatuses = ['success', 'failed', 'running', 'skipped'] as const;
export type ScheduleStatus = (typeof scheduleStatuses)[number];

export const scheduleModes = ['propose', 'auto'] as const;
export type ScheduleMode = (typeof scheduleModes)[number];

// cm:why `kind` is a plain text column with a TS-only enum, so adding a kind costs no migration — only every reader that switches on it. `prompt` dispatches a Claude agent session; `script` (ISS-618) and `release_batch` run in core with no session, no device and no runner.
export const scheduleKinds = ['prompt', 'script', 'release_batch'] as const;
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
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastStatus: text('last_status', { enum: scheduleStatuses }),
    lastSessionId: text('last_session_id'),
    metadata: jsonb('metadata'),
    templateKey: text('template_key'),
    params: jsonb('params'),
    mode: text('mode', { enum: scheduleModes }),
    appliedMessageVersions: jsonb('applied_message_versions'),
    kind: text('kind', { enum: scheduleKinds }).notNull().default('prompt'),
    script: text('script'),
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

// ISS-618 — run history for script-kind schedules (no agent_sessions row is
// created for these; prompt-kind run history still derives from agentSessions).
export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    trigger: text('trigger', { enum: ['manual', 'scheduled'] as const }).notNull(),
    status: text('status', { enum: scheduleStatuses }).notNull(),
    output: text('output'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scheduleCreatedIdx: index('schedule_runs_schedule_created_idx').on(t.scheduleId, t.createdAt),
  }),
);

export const scheduleRunsRelations = relations(scheduleRuns, ({ one }) => ({
  schedule: one(schedules, { fields: [scheduleRuns.scheduleId], references: [schedules.id] }),
  project: one(projects, { fields: [scheduleRuns.projectId], references: [projects.id] }),
}));

export const knowledgeEdges = pgTable(
  'knowledge_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    predicate: text('predicate').notNull(),
    object: text('object').notNull(),
    value: text('value'),
    sourceMemoryId: text('source_memory_id'),
    confidence: real('confidence').notNull().default(1.0),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSubjectIdx: index('knowledge_edges_project_subject_idx').on(t.projectId, t.subject),
    projectPredicateIdx: index('knowledge_edges_project_predicate_idx').on(
      t.projectId,
      t.predicate,
    ),
  }),
);

export const knowledgeEdgesRelations = relations(knowledgeEdges, ({ one }) => ({
  project: one(projects, { fields: [knowledgeEdges.projectId], references: [projects.id] }),
}));

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
    // ISS-439 — the job whose stored job_events this row was materialized from
    // (CLI-runner path). Bare uuid (no FK, mirroring jobs.agent_session_id) so
    // job retention/archival can't cascade-delete cost history. The partial
    // unique index below makes it the idempotency key: a job's usage row is
    // inserted ON CONFLICT DO NOTHING, so retries / sweeper-reaped terminals /
    // re-running the backfill can never double-count.
    jobId: uuid('job_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRecordedIdx: index('usage_records_project_recorded_idx').on(t.projectId, t.recordedAt),
    sessionIdIdx: index('usage_records_session_id_idx').on(t.sessionId),
    jobIdUq: uniqueIndex('usage_records_job_id_key').on(t.jobId).where(sql`job_id IS NOT NULL`),
  }),
);

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  project: one(projects, { fields: [usageRecords.projectId], references: [projects.id] }),
}));

export const qaRatings = ['good', 'bad', 'flagged'] as const;
export type QaRating = (typeof qaRatings)[number];

export const chatLogs = pgTable(
  'chat_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: text('session_id').notNull(),
    projectSlug: text('project_slug').notNull(),
    userKey: text('user_key'),
    query: text('query').notNull(),
    reply: text('reply'),
    model: text('model'),
    ragContext: jsonb('rag_context'),
    toolCalls: jsonb('tool_calls'),
    usage: jsonb('usage'),
    iterations: integer('iterations').notNull().default(1),
    durationMs: integer('duration_ms'),
    error: text('error'),
    queryIntent: text('query_intent'),
    condensedQuery: text('condensed_query'),
    source: text('source').notNull().default('web'),
    qualitySignals: jsonb('quality_signals'),
    qaRating: text('qa_rating', { enum: qaRatings }),
    qaNotes: text('qa_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index('chat_logs_project_created_idx').on(t.projectSlug, t.createdAt),
    sessionIdIdx: index('chat_logs_session_id_idx').on(t.sessionId),
    qaRatingIdx: index('chat_logs_qa_rating_idx').on(t.qaRating),
  }),
);

// cm:edge lockstep -> packages/contracts/src/notifications.ts — NOTIFICATION_TYPES + NOTIFICATION_CONTRACT carry the same taxonomy; core validates the column against THIS list while every emitter is typed against the contracts one, so a value added here alone is insertable but untyped, and one added there alone typechecks then fails at the column
export const notificationTypes = [
  'issue_status_changed',
  'comment_added',
  'agent_completed',
  'mention',
  'pm_escalation',
  // ISS-452 (ISS-442 C6 / I7) — a loop-monitor hop miss / non-progressing
  // pipeline state surfaced to the project owner (see pipeline/wedge.ts).
  'pipeline_wedge',
  // ISS-597 — pending project/org invitation surfaced to the invitee's bell.
  'invitation_received',
  // ISS-606 — intake gate parked a new issue at draft; owner must approve.
  'intake_pending',
  // ISS-618 — a script-kind schedule's ctx.notify() payload delivered to the
  // owner (report/API-check results with no LLM involved).
  'schedule_report',
  'reconcile_gate_pending',
  // cm:why ISS-762 — `waiting` + merged code is the one issue state that contradicts itself, and nothing else surfaces it
  'issue_stranded',
  'retry_rescue_threshold',
  'ops_alert',
] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type', { enum: notificationTypes }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    read: boolean('read').notNull().default(false),
    // ISS-510 — per-event severity (from the `@forge/contracts` notification
    // contract) drives toast tone + bell hue. Nullable: legacy rows predate it.
    severity: text('severity'),
    // cm:guard `resolvedAt IS NULL` is what "still happening" means, and every reader must use it — NOT `read = false`, which only says whether a human has looked. resolveNotifications clears by key on that predicate alone (this comment claimed "unread" until main corrected the code); an ops_alert additionally has a partial unique index over the same predicate, so a row left unstamped blocks its own recurrence forever.
    resolutionKey: text('resolution_key'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    // ISS-619 — a second, distinct issue reference for notifications whose
    // actionable target differs from `issueId` (e.g. a dependency-stall wedge:
    // `issueId` stays the wedged issue for interventions-metric attribution,
    // `secondaryIssueId` is the blocker/child the user actually needs to act on).
    secondaryIssueId: uuid('secondary_issue_id').references(() => issues.id, {
      onDelete: 'set null',
    }),
    agentSessionId: uuid('agent_session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // cm:why ISS-849 redelivery guard (`transition:<outboxId>`) — deliberately NOT `resolutionKey`, which answers "is the condition still true"; one key says do-not-send-twice, the other says the incident is over, and collapsing them would resolve an alert the moment it was redelivered
    dedupeKey: text('dedupe_key'),
  },
  (t) => ({
    userReadCreatedIdx: index('notifications_user_read_created_idx').on(
      t.userId,
      t.read,
      t.createdAt,
    ),
    projectCreatedIdx: index('notifications_project_created_idx').on(t.projectId, t.createdAt),
    // ISS-510 — resolver lookup: unread rows for a given resolution key.
    resolutionKeyIdx: index('notifications_resolution_key_read_idx').on(t.resolutionKey, t.read),
    // cm:guard alert-sweeper.ts's `INSERT ... ON CONFLICT (user_id, resolution_key) WHERE ...` infers THIS index, so its predicate must match verbatim or the insert throws; and the `type = 'ops_alert'` scope must stay, because notify-transitions.ts legitimately leaves several active rows under one `issue:<id>:status` key (waiting + reopen) that an unscoped unique index would refuse to create over and then silently drop
    opsAlertActiveUq: uniqueIndex('notifications_ops_alert_active_uq')
      .on(t.userId, t.resolutionKey)
      .where(sql`resolved_at IS NULL AND resolution_key IS NOT NULL AND type = 'ops_alert'`),
    dedupeKeyIdx: index('notifications_dedupe_key_idx').on(t.dedupeKey),
  }),
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  project: one(projects, { fields: [notifications.projectId], references: [projects.id] }),
  issue: one(issues, { fields: [notifications.issueId], references: [issues.id] }),
}));

export const agentSchedules = ['off', 'weekly', 'biweekly', 'monthly'] as const;
export type AgentSchedule = (typeof agentSchedules)[number];

export const agentApprovalModes = ['preview', 'auto-create'] as const;
export type AgentApprovalMode = (typeof agentApprovalModes)[number];

// Folds the legacy `agent-definition` template into the agent row itself —
// no template inheritance per Tier B2 plan.
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(false),
    focusAreas: jsonb('focus_areas')
      .notNull()
      .default(
        sql`'["feature-gaps","journey-completeness","polish","accessibility","ux-improvements"]'::jsonb`,
      ),
    customInstructions: text('custom_instructions'),
    schedule: text('schedule', { enum: agentSchedules }).notNull().default('off'),
    approvalMode: text('approval_mode', { enum: agentApprovalModes }).notNull().default('preview'),
    maxProposals: integer('max_proposals').notNull().default(10),
    excludeCategories: jsonb('exclude_categories').notNull().default(sql`'[]'::jsonb`),
    promptTemplate: text('prompt_template'),
    reindexPromptTemplate: text('reindex_prompt_template'),
    knowledge: text('knowledge'),
    memory: text('memory'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectTypeIdx: index('agents_project_type_idx').on(t.projectId, t.type),
  }),
);

export const agentsRelations = relations(agents, ({ one }) => ({
  project: one(projects, { fields: [agents.projectId], references: [projects.id] }),
}));

export const chatSessionSources = ['web', 'widget', 'rocketchat', 'telegram'] as const;
export type ChatSessionSource = (typeof chatSessionSources)[number];

/**
 * Persisted chat sessions. Two separate identity columns are intentional:
 *
 * - `userId` is the authenticated owner — set when the request carries a Bearer
 *   JWT (web/desktop). Drives the per-user scoping in GET/PATCH/DELETE.
 * - `userKey` is the chat_logs audit key — propagated to `chat_logs.userKey`
 *   inside `chat/run-turn.ts`.
 */
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    userKey: text('user_key'),
    title: text('title'),
    source: text('source', { enum: chatSessionSources }).notNull().default('web'),
    messages: jsonb('messages').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectUpdatedIdx: index('chat_sessions_project_updated_idx').on(t.projectId, t.updatedAt),
    userIdx: index('chat_sessions_user_idx').on(t.userId),
  }),
);

export const chatSessionsRelations = relations(chatSessions, ({ one }) => ({
  project: one(projects, { fields: [chatSessions.projectId], references: [projects.id] }),
  user: one(users, { fields: [chatSessions.userId], references: [users.id] }),
}));

// ISS-197 — `completed_via_recovery` / `cancelled_stale` are non-failure
// terminal markers written by the recovery-by-verification path in
// `jobs/retry.ts`. UI filters / analytics that partition on
// agent_sessions.status treat them as success states, not failures.
export const agentSessionStatuses = [
  'idle',
  'queued',
  'running',
  'completed',
  'failed',
  'completed_via_recovery',
  'cancelled_stale',
] as const;
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];

// cm:guard the four statuses after which NOTHING more can happen in the session. `resolveSessionSend` reads this to decide a queued message can never be consumed, and `lifecycle/transition.ts` restricts its `to` to it — a status added here that is not in fact terminal would let a send resolve `gone` against a session still running, which is the second-agent-on-one-worktree race RFC 0003 exists to avoid.
export const terminalAgentSessionStatuses = [
  'completed',
  'failed',
  'completed_via_recovery',
  'cancelled_stale',
] as const satisfies readonly AgentSessionStatus[];

// cm:guard `status` and `runtimeState` answer different questions and must never be collapsed: `status` is the JOB's lifecycle (a `running` session may be mid-turn or parked on stdin), `runtimeState` is the PROCESS's, and it is the only one that distinguishes a session waiting for input from one still working. Print-mode sessions leave it NULL — a NULL here means "this runner never reported, infer nothing", which is not the same as `working`.
// cm:guard `awaiting_input` is exempt from the loop-monitor QUIET-TIMEOUT only — it still HOLDS ITS RUNNER SLOT the entire time it is parked, exactly like `working`, and the residency window is what bounds it instead. Reading this as slot-exempt is the misreading that leaks a duplex session permanently: the box's `duplex_max_sessions` is a small number (3 by default) and core enforces no ceiling of its own, so once the quiet clock no longer applies the residency deadline is the only thing that will ever reap a parked session.
export const sessionRuntimeStates = [
  'starting',
  'working',
  'awaiting_input',
  'checkpointing',
  'closed',
] as const;
export type SessionRuntimeState = (typeof sessionRuntimeStates)[number];

// cm:edge contract -> packages/contracts/src/failure-causes.ts — ISS-877 made that module the single taxonomy for core, web-v2 and the MCP metric; this alias exists so the schema keeps naming its own column's vocabulary, not so a second list can grow here
// cm:guard dispatcher gate skips (issue_busy / waiting_on_dep / project_full / manual_hold) are NOT members and must never be added — ISS-162 made them stateless, recomputed by the picker every tick, so persisting one on the session row revives a gate state that goes stale the moment the condition clears
export const agentSessionFailureReasons = FAILURE_CAUSES;
export type AgentSessionFailureReason = FailureCause;

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
    diff: jsonb('diff'),
    pipelineControl: jsonb('pipeline_control').$type<
      import('../agent-sessions/pipeline-control-types.js').PipelineControl | null
    >(),
    pipelineTelemetry: jsonb('pipeline_telemetry'),
    pipelineHealth: jsonb('pipeline_health').$type<
      import('../agent-sessions/pipeline-control-types.js').PipelineHealth | null
    >(),
    // cm:guard ISS-34 zombie-fix stamps, and each marks a DIFFERENT moment: `dispatchedAt` when the pipeline enqueues, `startedAt` only when a worker CAS-claims queued→running, `lastHeartbeatAt` on EVERY worker write (message append, claudeSessionId set, status patch). The heartbeat reaper reads the third; widening what bumps it, or bumping it from a core-side write, makes a dead runner look alive.
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    // cm:guard ISS-877 — the `{ enum }` here is the ONLY thing stopping free text returning to this column, so removing it is not a typing detail: `agent-sessions/session-failure.ts` used to write a classifier SENTENCE where `queue_timeout` writes a token, and 55 live rows ended up holding prose, 9 of them the agent's own prompt. There is no CHECK constraint on purpose — migration 0180 measured what one costs here, where a missed writer turns every INSERT into a 23514 — so the compile error is the whole enforcement, and the human sentence goes to `failureDetail`.
    failureReason: text('failure_reason', { enum: agentSessionFailureReasons }),
    failureDetail: text('failure_detail'),
    runtimeState: text('runtime_state', { enum: sessionRuntimeStates }),
    // cm:guard the HIGHEST inbox seq core has ALLOCATED for this session, not the highest the runner applied — the runner reports what it applied and core never back-fills this from it. Allocate with `UPDATE ... SET last_inbox_seq = last_inbox_seq + 1 RETURNING`, never a read-then-write: two concurrent sends that both read N and both send N+1 end with one written and the other dropped-and-acked-delivered, which is a silent message loss the ack contract says cannot happen.
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

// ISS-499 — files a user attaches to an interactive chat turn ("My
// conversations"). Mirrors `comment_attachments` (user notNull, device
// nullable audit shape). The runner auth-downloads these to a local path so
// claude can Read them (image vision + text/PDF) within the turn.
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
    // Populated when the uploader was a device principal (MCP path); null for
    // user-principal uploads (REST multipart from web-v2).
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

// v1 EPIC 5 (ISS-274) — per-project chat/runtime config. One row per project,
// upserted via PUT /api/app-config/:projectId. `chatProviderId` is free-form
// text until EPIC 1 (ISS-270) ships the chat-provider registry that validates
// it; consumers must fall back to env defaults when the provider is unknown.
export const memoryModels = ['flat', 'chunked'] as const;
export type MemoryModel = (typeof memoryModels)[number];

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
  retrievalTopK: integer('retrieval_top_k').notNull().default(10),
  retrievalMinScore: real('retrieval_min_score').notNull().default(0),
  // cm:guard the four retrieval-v3 flags default to today's behaviour (off / flat / off / {}) and NOTHING reads them until its phase ships — docs/proposals/retrieval-v3-rerank-chunks.md; `memoryReindex` is written only by the phase-2 reindex job, never by PUT /api/app-config, so a stale client PUT cannot erase a running migration's state
  retrievalRerank: boolean('retrieval_rerank').notNull().default(false),
  memoryModel: text('memory_model', { enum: memoryModels }).notNull().default('flat'),
  retrievalExpandRelations: boolean('retrieval_expand_relations').notNull().default(false),
  memoryReindex: jsonb('memory_reindex').notNull().default(sql`'{}'::jsonb`),
  enabledChannels: jsonb('enabled_channels').notNull().default(sql`'[]'::jsonb`),
  systemPromptOverride: text('system_prompt_override'),
  lastBackfillAt: timestamp('last_backfill_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appConfigRelations = relations(appConfig, ({ one }) => ({
  project: one(projects, { fields: [appConfig.projectId], references: [projects.id] }),
}));

// v1 EPIC 5 (ISS-274) — content-addressed domain template manifests. Mirrors
// the skills seed pattern: builtin manifests get re-seeded when their
// `contentHash` changes; user-applied snapshots are not retroactively bumped.
export const domainTemplates = pgTable('domain_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  manifest: jsonb('manifest').notNull(),
  contentHash: text('content_hash').notNull(),
  builtin: boolean('builtin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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

// cm:guard only `kind='blocks'` gates dispatch: an edge (from=A, to=B, 'blocks') means A must reach a terminal status before B may dispatch, and cross-project edges are legal. every other kind — `relates`, `duplicates`, `parent` and `decomposes` (epic→child) — is PM/UX metadata a dispatch path must never read. `decomposes` used to drive a parent lifecycle of its own; that was removed 2026-09-03 and it is now a grouping label, so ordering under an epic needs its own `blocks` edge.

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

export const pmDecisions = pgTable(
  'pm_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Bare uuid (no FK) — mirrors notifications.agent_session_id; the
    // observability `agent_sessions` row may be GC'd before the decision is.
    sessionId: uuid('session_id'),
    cause: text('cause').notNull(),
    eventRef: jsonb('event_ref').notNull().default(sql`'{}'::jsonb`),
    summary: text('summary').notNull(),
    actions: jsonb('actions').notNull().default(sql`'[]'::jsonb`),
    confidence: real('confidence'),
    modelTier: text('model_tier'),
    tookMs: integer('took_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index('pm_decisions_project_created_idx').on(
      t.projectId,
      sql`${t.createdAt} DESC`,
    ),
  }),
);

export const pmDecisionsRelations = relations(pmDecisions, ({ one }) => ({
  project: one(projects, { fields: [pmDecisions.projectId], references: [projects.id] }),
}));

export const pmConfig = pgTable('pm_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  // null = event-only, no cron tick
  cadenceCron: text('cadence_cron'),
  eventTriggers: jsonb('event_triggers')
    .notNull()
    .default(
      sql`'{"jobFailed":true,"pipelineStalled":true,"needsInfo":true,"queuePressure":true,"graphChanged":true}'::jsonb`,
    ),
  customInstructions: text('custom_instructions'),
  // null = use app_config default model
  modelOverride: text('model_override'),
  maxRunsPerHour: integer('max_runs_per_hour').notNull().default(6),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pmConfigRelations = relations(pmConfig, ({ one }) => ({
  project: one(projects, { fields: [pmConfig.projectId], references: [projects.id] }),
}));

export const pmPolicies = pgTable(
  'pm_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    body: text('body').notNull(),
    // Nullable: filled asynchronously by the memory indexer (Epic 6).
    embedding: pgVector(MEMORY_EMBEDDING_DIM)('embedding'),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectEnabledPriorityIdx: index('pm_policies_project_enabled_priority_idx').on(
      t.projectId,
      t.enabled,
      sql`${t.priority} DESC`,
    ),
    embeddingHnswIdx: index('pm_policies_embedding_hnsw_idx').using(
      'hnsw',
      sql`"embedding" vector_cosine_ops`,
    ),
  }),
);

export const pmPoliciesRelations = relations(pmPolicies, ({ one }) => ({
  project: one(projects, { fields: [pmPolicies.projectId], references: [projects.id] }),
}));

// ISS-196 — transactional outbox. Rows are produced by the AFTER UPDATE
// trigger on `issues.status` (see migration 0070) and consumed by the
// outbox worker which re-emits the `transition` hook for the orchestrator.
// Schema mirror; the partial index `idx_outbox_unprocessed` is enforced at
// the DB level only.
export const pipelineOutbox = pgTable('pipeline_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  issueId: uuid('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status').notNull(),
  toStatus: text('to_status').notNull(),
  actorId: text('actor_id'),
  actorType: text('actor_type'),
  reason: text('reason'),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
});

// ISS-234 — Integration Framework foundation. secrets_enc columns hold the
// AES-256-GCM ciphertext produced by src/integrations/vault.ts; the legacy
// project_integrations table was retired by ISS-410 (epic ISS-404, F5) in
// favour of the integration_connections / integration_bindings model below.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// ISS-628 — org-scoped Private Keys pool (workspace resource). A key is
// generated/pasted once per org and referenced by any number of projects in
// that org, replacing the old 1:1-per-project model below. `forge_generated`
// => Forge minted the ed25519 pair (private encrypted here, public surfaced
// for the user to add as a deploy key); `user_provided` => the user pasted
// their own private key (encrypted the same way). Listing/showing a key NEVER
// decrypts the private half — it is decrypted only at device provisioning,
// delivered once over the wire (mirrors the ISS-305 side-channel).
export const projectGitCredentialSources = ['forge_generated', 'user_provided'] as const;
export type ProjectGitCredentialSource = (typeof projectGitCredentialSources)[number];

export const workspaceSshKeyTypes = ['ed25519'] as const;
export type WorkspaceSshKeyType = (typeof workspaceSshKeyTypes)[number];

export const workspaceSshKeys = pgTable(
  'workspace_ssh_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    note: text('note'),
    source: text('source', { enum: projectGitCredentialSources }).notNull(),
    keyType: text('key_type', { enum: workspaceSshKeyTypes }).notNull().default('ed25519'),
    // Non-secret OpenSSH public key line ("ssh-ed25519 AAAA… forge-<slug>").
    publicKey: text('public_key').notNull(),
    // Vault-encrypted (<iv:12><tag:16><ct>) OpenSSH private key — same format as
    // integration_connections.secrets_enc; decrypt only at provision dispatch.
    privateKeyEnc: bytea('private_key_enc').notNull(),
    // Non-secret SHA256 fingerprint for display + dedup ("SHA256:…"). Nullable
    // to tolerate legacy rows folded in by migration 0150 that predate
    // fingerprint capture.
    fingerprint: text('fingerprint'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdIdx: index('workspace_ssh_keys_org_id_idx').on(t.orgId),
    // Dedup identical physical keys within an org (Coolify pattern). Partial so
    // legacy rows without a captured fingerprint (NULL) never collide.
    orgFingerprintUq: uniqueIndex('workspace_ssh_keys_org_fingerprint_uq')
      .on(t.orgId, t.fingerprint)
      .where(sql`fingerprint IS NOT NULL`),
  }),
);

export const workspaceSshKeysRelations = relations(workspaceSshKeys, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [workspaceSshKeys.orgId],
    references: [organizations.id],
  }),
  creator: one(users, { fields: [workspaceSshKeys.createdBy], references: [users.id] }),
  projects: many(projectGitCredentials),
}));

// Per-project Git access — a thin (project_id, ssh_key_id) reference into the
// org's `workspace_ssh_keys` pool. A project picks at most one pool key; many
// projects may reference the same key. ON DELETE RESTRICT backs the
// server-side safe-delete guard at the DB level (a pool key in use can't be
// dropped out from under a project).
export const projectGitCredentials = pgTable(
  'project_git_credentials',
  {
    // 1:1 with the project — PK is the FK so a project has at most one reference.
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sshKeyId: uuid('ssh_key_id')
      .notNull()
      .references(() => workspaceSshKeys.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sshKeyIdIdx: index('project_git_credentials_ssh_key_id_idx').on(t.sshKeyId),
  }),
);

export const projectGitCredentialsRelations = relations(projectGitCredentials, ({ one }) => ({
  project: one(projects, {
    fields: [projectGitCredentials.projectId],
    references: [projects.id],
  }),
  sshKey: one(workspaceSshKeys, {
    fields: [projectGitCredentials.sshKeyId],
    references: [workspaceSshKeys.id],
  }),
}));

export const integrationEnvironments = ['staging', 'prod'] as const;
export type IntegrationEnvironment = (typeof integrationEnvironments)[number];

export const integrationDeliveryDirections = ['outbound', 'inbound'] as const;
export type IntegrationDeliveryDirection = (typeof integrationDeliveryDirections)[number];

export const integrationDeliveryStatuses = ['pending', 'ok', 'failed'] as const;
export type IntegrationDeliveryStatus = (typeof integrationDeliveryStatuses)[number];

export const integrationDeliveries = pgTable(
  'integration_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Connection/Binding model: the dispatch/read key after the ISS-399 cutover.
    // The legacy project-integration link column was dropped by ISS-410 (epic F5).
    bindingId: uuid('binding_id').references(() => integrationBindings.id, {
      onDelete: 'cascade',
    }),
    direction: text('direction', { enum: integrationDeliveryDirections }).notNull(),
    eventName: text('event_name').notNull(),
    requestId: text('request_id'),
    status: text('status', { enum: integrationDeliveryStatuses }).notNull().default('pending'),
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
    // Post-cutover idempotency key (mirrors requestIdUq on the legacy column):
    // a dispatch keyed by (binding, requestId) is deduped at the DB level.
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
// by a principal — user now, org later) is split from the per-project+env LINK
// (binding). Tables land empty+backfilled; all current read/dispatch paths keep
// using project_integrations until the REST cutover issue flips them. Owner is a
// generic principal so org-level sharing arrives without a data migration.

export const integrationOwnerTypes = ['user', 'org'] as const;
export type IntegrationOwnerType = (typeof integrationOwnerTypes)[number];

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Generic principal. ownerType discriminates the namespace of ownerId so we
    // can add 'org' later without re-keying rows; no FK because it is polymorphic.
    ownerType: text('owner_type', { enum: integrationOwnerTypes }).notNull().default('user'),
    ownerId: uuid('owner_id').notNull(),
    provider: text('provider').notNull(),
    displayName: text('display_name'),
    // Connection-scoped non-secret config (e.g. coolify baseUrl, postman
    // region/mode, epodsystem store identity). Per-project overrides live on the
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
    lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
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
    environment: text('environment', { enum: integrationEnvironments }).notNull(),
    // Per-binding overrides (e.g. coolify `targets[]` deploy apps). Overlaid on
    // top of connection.config at dispatch time.
    config: jsonb('config').notNull().default({}),
    // Per-binding HMAC secret for inbound webhook signature verification — an
    // inbound webhook is project+env scoped, so this stays on the binding.
    integrationSecret: text('integration_secret'),
    // ISS-558 — multi-store support for epodsystem. Empty string = the default
    // (unlabeled) binding; a non-empty kebab slug = a named extra binding.
    // Non-epodsystem providers always leave this as '' (the DB default), so
    // UNIQUE(project_id, provider, environment, label) still keeps the
    // one-per-(project,provider,env) invariant for coolify/postman/sentry.
    label: text('label').notNull().default(''),
    active: boolean('active').notNull().default(true),
    // cm:guard NEVER put a credential here — this text is rendered verbatim into every agent prompt for the project, so anything stored is effectively published to the model
    instructions: text('instructions'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connectionIdx: index('integration_bindings_connection_idx').on(t.connectionId),
    projectProviderIdx: index('integration_bindings_project_provider_idx').on(
      t.projectId,
      t.provider,
    ),
    // ISS-558: label column added. UNIQUE(project_id, provider, environment, label)
    // preserves the one-per-(project,provider,env) invariant for all providers
    // (label='' for non-epodsystem) while allowing multiple labeled epodsystem bindings.
    projectProviderEnvLabelUq: uniqueIndex('integration_bindings_project_provider_env_label_uq').on(
      t.projectId,
      t.provider,
      t.environment,
      t.label,
    ),
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
 * (the presigned-URL pattern). `forge_uploads` mints a row; the holder PUTs file
 * bytes to /api/uploads/:id with no bearer — possession of the unguessable id +
 * not-expired + not-consumed IS the authorization. All upload params are stored
 * server-side here so the URL cannot be tampered with.
 */
export const uploadTickets = pgTable(
  'upload_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetType: text('target_type').notNull(), // 'issue' | 'comment'
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

// ISS-381 (2.3) — runner status-change audit. One row per actual transition,
// written change-gated at every runners.status mutation site. old_status is
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

// ISS-552 (C1) — append-only agent friction feed. Agents submit friction,
// ambiguous steps, skill gaps, and learnings mid-run; the owner reads the raw
// feed before the normalizer (C2) accrues signals into memory candidates.
// candidate_id column present but FK-less until C2 adds the target table.
export const feedbackKinds = [
  'friction',
  'bug',
  'skill_gap',
  'unclear_step',
  'redundant_step',
  'learning',
  'suggestion',
] as const;
export type FeedbackKind = (typeof feedbackKinds)[number];

export const feedbackSeverities = ['low', 'medium', 'high'] as const;
export type FeedbackSeverity = (typeof feedbackSeverities)[number];

export const feedbackTargets = [
  'skill',
  'prompt',
  'tool',
  'doc',
  'orientation',
  'pipeline',
  'other',
] as const;
export type FeedbackTarget = (typeof feedbackTargets)[number];

export const feedbackReports = pgTable(
  'feedback_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    stage: text('stage'),
    skillName: text('skill_name'),
    skillVersion: integer('skill_version'),
    kind: text('kind', { enum: feedbackKinds }).notNull(),
    severity: text('severity', { enum: feedbackSeverities }).notNull().default('low'),
    target: text('target', { enum: feedbackTargets }).notNull(),
    targetRef: text('target_ref'),
    summary: text('summary').notNull(),
    detail: text('detail'),
    suggestion: text('suggestion'),
    // FK added by C2 (ISS-553).
    candidateId: uuid('candidate_id').references(() => memoryCandidates.id, {
      onDelete: 'set null',
    }),
    // Server-computed `self_report:<target>:<targetRef|'-'>:<kind>`.
    // Stored for C2 signal accrual + list dedup.
    signalKey: text('signal_key').notNull(),
    // ISS-557 — bare uuid pointing at the agent_session that emitted this report.
    // No hard FK so steward sessions (which have no job row) can link cleanly.
    sessionId: uuid('session_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    // ISS-712 — issue the report was curated INTO (distinct from `issueId`,
    // which is the SOURCE issue the agent was working on when it reported).
    // Set only via the `review` action's explicit linkedIssueId param.
    linkedIssueId: uuid('linked_issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdx: index('feedback_reports_project_id_idx').on(t.projectId),
    projectKindIdx: index('feedback_reports_project_kind_idx').on(t.projectId, t.kind),
    projectTargetIdx: index('feedback_reports_project_target_idx').on(
      t.projectId,
      t.target,
      t.targetRef,
    ),
    signalKeyIdx: index('feedback_reports_signal_key_idx').on(t.signalKey),
    createdAtIdx: index('feedback_reports_created_at_idx').on(t.createdAt),
    sessionIdx: index('feedback_reports_session_id_idx').on(t.sessionId),
    linkedIssueIdIdx: index('feedback_reports_linked_issue_id_idx').on(t.linkedIssueId),
  }),
);

export const feedbackReportsRelations = relations(feedbackReports, ({ one }) => ({
  project: one(projects, { fields: [feedbackReports.projectId], references: [projects.id] }),
  issue: one(issues, { fields: [feedbackReports.issueId], references: [issues.id] }),
  linkedIssue: one(issues, {
    fields: [feedbackReports.linkedIssueId],
    references: [issues.id],
  }),
  run: one(pipelineRuns, { fields: [feedbackReports.runId], references: [pipelineRuns.id] }),
  job: one(jobs, { fields: [feedbackReports.jobId], references: [jobs.id] }),
}));

// ISS-554 — bottom-up improvement message drafts.
// Stores proposals seeded by the curator's "promote" action on a graduated candidate.
// These are global (not per-project) like the static registry, but dynamically created.
// A human curator reviews pending_review drafts before they graduate into the static registry.
export const improvementMessageDraftStatuses = [
  'pending_review',
  'published',
  'dismissed',
] as const;
export type ImprovementMessageDraftStatus = (typeof improvementMessageDraftStatuses)[number];

export const improvementMessageDraftSources = ['bottom_up'] as const;
export type ImprovementMessageDraftSource = (typeof improvementMessageDraftSources)[number];

export const improvementMessageDrafts = pgTable(
  'improvement_message_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stable kebab key; unique across the table (draft-<slugified-signalKey>).
    key: text('key').notNull(),
    title: text('title').notNull(),
    // Message body sourced from agent feedback — content is UNTRUSTED.
    message: text('message').notNull(),
    rationale: text('rationale').notNull(),
    appliesWhen: text('applies_when'),
    appliesToSkills: jsonb('applies_to_skills').notNull().default([]),
    category: text('category').notNull().default('general'),
    status: text('status', { enum: improvementMessageDraftStatuses })
      .notNull()
      .default('pending_review'),
    source: text('source', { enum: improvementMessageDraftSources }).notNull().default('bottom_up'),
    // Provenance: the candidate and signal that seeded this draft.
    candidateId: uuid('candidate_id').references(() => memoryCandidates.id, {
      onDelete: 'set null',
    }),
    signalKey: text('signal_key').notNull(),
    sourceProjectId: uuid('source_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex('improvement_message_drafts_key_uq').on(t.key),
    statusIdx: index('improvement_message_drafts_status_idx').on(t.status),
    candidateIdx: index('improvement_message_drafts_candidate_idx').on(t.candidateId),
    signalKeyIdx: index('improvement_message_drafts_signal_key_idx').on(t.signalKey),
  }),
);

// ISS-574 — Foundation for the UX Completeness Contract epic.
// `ux_contract_rules` is the source-of-truth rule set; the compiler turns
// active rules → projectFacts['ux-contract'] prose on every mutation.
// `ux_findings` records per-issue per-run observations that cite a rule.

export const uxRuleGroups = [
  'designSystem',
  'states',
  'flows',
  'a11y',
  'microcopy',
  'responsive',
] as const;
export type UxRuleGroup = (typeof uxRuleGroups)[number];

export const uxRuleSeverities = ['must', 'should'] as const;
export type UxRuleSeverity = (typeof uxRuleSeverities)[number];

export const uxRuleSources = ['preset', 'detected', 'learned', 'manual'] as const;
export type UxRuleSource = (typeof uxRuleSources)[number];

export const uxRuleStatuses = ['active', 'proposed', 'retired'] as const;
export type UxRuleStatus = (typeof uxRuleStatuses)[number];

export const uxFindingStages = ['review', 'verify-live'] as const;
export type UxFindingStage = (typeof uxFindingStages)[number];

export const uxFindingKinds = [
  'missing-state',
  'a11y',
  'microcopy',
  'responsive',
  'design-system',
  'other',
] as const;
export type UxFindingKind = (typeof uxFindingKinds)[number];

export const uxContractRules = pgTable(
  'ux_contract_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    group: text('group', { enum: uxRuleGroups }).notNull(),
    text: text('text').notNull(),
    severity: text('severity', { enum: uxRuleSeverities }).notNull().default('must'),
    source: text('source', { enum: uxRuleSources }).notNull().default('manual'),
    status: text('status', { enum: uxRuleStatuses }).notNull().default('active'),
    evidenceIssueIds: jsonb('evidence_issue_ids').notNull().default([]),
    // cm:guard ISS-579 — a `proposed` row pointing here REPLACES its target on approval; the PATCH route retires the target in the same request. compileUxContract renders only `text`, so without this link an approved should→must strengthen would leave BOTH rules active and the prose would carry the rule twice.
    supersedesRuleId: uuid('supersedes_rule_id').references((): AnyPgColumn => uxContractRules.id, {
      onDelete: 'set null',
    }),
    orderIndex: integer('order_index').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectStatusIdx: index('ux_contract_rules_project_status_idx').on(t.projectId, t.status),
    projectGroupIdx: index('ux_contract_rules_project_group_idx').on(t.projectId, t.group),
  }),
);

export const uxContractRulesRelations = relations(uxContractRules, ({ one, many }) => ({
  project: one(projects, { fields: [uxContractRules.projectId], references: [projects.id] }),
  findings: many(uxFindings),
}));

export const uxFindings = pgTable(
  'ux_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references((): AnyPgColumn => issues.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    stage: text('stage', { enum: uxFindingStages }).notNull(),
    ruleId: uuid('rule_id').references(() => uxContractRules.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: uxFindingKinds }).notNull(),
    detail: text('detail').notNull(),
    severity: text('severity', { enum: uxRuleSeverities }).notNull().default('must'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIssueIdx: index('ux_findings_project_issue_idx').on(t.projectId, t.issueId),
    ruleIdx: index('ux_findings_rule_idx').on(t.ruleId),
  }),
);

export const uxFindingsRelations = relations(uxFindings, ({ one }) => ({
  project: one(projects, { fields: [uxFindings.projectId], references: [projects.id] }),
  issue: one(issues, { fields: [uxFindings.issueId], references: [issues.id] }),
  rule: one(uxContractRules, { fields: [uxFindings.ruleId], references: [uxContractRules.id] }),
  pipelineRun: one(pipelineRuns, { fields: [uxFindings.runId], references: [pipelineRuns.id] }),
}));

// cm:why keyed by provider, not slug — the guide documents a SERVICE, so one row per integration per org; the slug is derived, which is what lets a single lookup reach either this tier or the code registry
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
    // cm:guard bump on every body edit — readers cache by (slug, version), so an edit that leaves this alone serves stale bytes
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

// cm:why the unguessable id IS the credential (mirror of `upload_tickets`) — the bearer-guarded download route 401s for a device token, a PAT and no-auth alike, so nothing on a runner, and no third-party told to fetch the URL, could ever obtain an attachment's bytes
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
    // cm:guard NOT single-use — a third-party fetcher retries, and burning the ticket on the first attempt reintroduces the "cannot get the bytes" dead end. The short TTL is the containment, not a use counter.
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

// cm:why divergence_charters is item 7 in the Master agent's context bundle (ISS-795 §4 / Update Pipeline §5).
// cm:guard Charter mutations MUST emit `charter.changed` into `skill_activity_events` in the same transaction (invariant §9.11).

export const divergenceCharters = pgTable(
  'divergence_charters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // cm:why jsonb array — each element is a DivergenceCharterEntry (see contracts/divergence-charters.ts); append-only in practice, agent never deletes individual entries.
    entries: jsonb('entries').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectUq: uniqueIndex('divergence_charters_project_uq').on(t.projectId),
  }),
);

export const divergenceChartersRelations = relations(divergenceCharters, ({ one }) => ({
  project: one(projects, { fields: [divergenceCharters.projectId], references: [projects.id] }),
}));

export const reconcileVerdicts = ['no-op', 'apply', 'apply-with-adaptation', 'escalate'] as const;
export type ReconcileVerdict = (typeof reconcileVerdicts)[number];

export const reconcileRunStatuses = [
  'pending',
  'running',
  'verifying',
  'decided',
  'applied',
  'escalated',
  'failed',
] as const;
export type ReconcileRunStatus = (typeof reconcileRunStatuses)[number];

export const reconcileGates = ['auto', 'human'] as const;
export type ReconcileGate = (typeof reconcileGates)[number];

// cm:edge contract -> packages/core/src/guides/registry.ts#update-pipeline-reconcile — that guide is the field-by-field reference the reconcile agents are pointed at; adding or renaming a key here without updating it teaches them about a field that does not exist, or hides one that does
// cm:why `sources` labels each key's provenance per C3.
export interface ReconcileBundleSnapshot {
  readAt: string;
  change: string;
  story: string;
  intentClass: string;
  appliesTo: string;
  provenance: Record<string, unknown>;
  runningBody: string;
  runningHash: string;
  charter: unknown | null;
  projectFacts: Record<string, unknown>;
  pipelineConfig: Record<string, unknown>;
  recentRunEvidence: unknown[];
  priorReconcileHistory: unknown[];
  invariantSet: Record<string, unknown>;
  mustNotBreak: string[];
  sources: Record<string, 'human' | 'from-code' | 'observed-from-run' | 'agent-assertion'>;
}

export interface ReconcileVerifierVote {
  jobId: string;
  vote: 'pass' | 'fail';
  reason: string;
  decidedAt: string;
}

// cm:guard any update to reconcile_runs.status must emit the matching event into skill_activity_events in the same transaction (ISS-795 §9.11/§9.7).
// cm:guard reconcile_runs_active_project_uq serializes per-project — insert only via spawnReconcileRun, which turns the unique-violation into 'already-active'.

export const reconcileRuns = pgTable(
  'reconcile_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    packetId: uuid('packet_id').references(() => updatePackets.id, { onDelete: 'set null' }),
    skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    status: text('status', { enum: reconcileRunStatuses }).notNull().default('pending'),
    verdict: text('verdict', { enum: reconcileVerdicts }),
    gate: text('gate', { enum: reconcileGates }),
    bundle: jsonb('bundle').notNull().default({}).$type<ReconcileBundleSnapshot>(),
    candidateBody: text('candidate_body'),
    candidateHash: text('candidate_hash'),
    lastGoodBody: text('last_good_body'),
    lastGoodHash: text('last_good_hash'),
    verifierVotes: jsonb('verifier_votes').notNull().default([]).$type<ReconcileVerifierVote[]>(),
    rationale: text('rationale'),
    refusalReason: text('refusal_reason'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // cm:why acknowledgedAt/By (ISS-807) resolve an escalated run's attention item — orthogonal to `status`, which stays the run's terminal state.
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    // cm:guard partial unique index — enforces at most one active run per project; includes 'decided' so a run awaiting the human gate also blocks a new trigger (MINOR G, ISS-801 review).
    activeProjectUq: uniqueIndex('reconcile_runs_active_project_uq')
      .on(t.projectId)
      .where(sql`status IN ('pending','running','verifying','decided')`),
    projectCreatedIdx: index('reconcile_runs_project_created_idx').on(t.projectId, t.createdAt),
    packetIdx: index('reconcile_runs_packet_idx').on(t.packetId),
    // cm:edge contract -> packages/core/src/me/attention-buckets.ts — the pendingSkillUpdates bucket's escalated-run clause mirrors this predicate; keep both in sync.
    pendingGateIdx: index('reconcile_runs_pending_gate_idx')
      .on(t.projectId)
      .where(
        sql`(status = 'decided' AND gate = 'human') OR (status = 'escalated' AND verdict = 'escalate' AND acknowledged_at IS NULL)`,
      ),
  }),
);

export const reconcileRunsRelations = relations(reconcileRuns, ({ one }) => ({
  project: one(projects, { fields: [reconcileRuns.projectId], references: [projects.id] }),
  skill: one(skills, { fields: [reconcileRuns.skillId], references: [skills.id] }),
}));
