import { type SQL, relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
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
import type { IssueBranchOverride } from '../branches/resolve.js';
import type { ReleaseNotes } from '../issues/release-notes.js';

/**
 * pgvector column type. Dimension is fixed per column — the `memories.embedding`
 * column below uses `vector(1536)` per ADR 0011. Stored as a bracketed string on
 * the wire (`[0.1,0.2,...]`), deserialised to number[] by the driver.
 */
export const pgVector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(v) {
      return `[${v.join(',')}]`;
    },
    fromDriver(v) {
      return typeof v === 'string' ? (JSON.parse(v) as number[]) : (v as number[]);
    },
  });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  // Nullable since 0037: OAuth-only users have no local password. The
  // /auth/local handler rejects rows with a null hash so password-less
  // accounts cannot be brute-forced via the email/password endpoint.
  passwordHash: text('password_hash'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  // Last time the user re-entered their password via POST /api/auth/reauth.
  // Drives the requireFreshAuth() middleware; nullable for users that have
  // never re-authed (treated as stale → forces a prompt). See migration 0065.
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
    // 'github' | 'google' | 'oidc' — kept as text rather than an enum so a
    // future provider doesn't require a migration to add a value.
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

// Desktop sign-in pairing codes (ADR 0019; supersedes ADR 0017). Short code
// minted on the desktop, approved in a signed-in browser, polled by the
// desktop to receive a JWT. Distinct from `pairingCodes` (further down)
// which couples a device to a project at first run.
export const desktopPairingCodes = pgTable(
  'desktop_pairing_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull().unique(),
    deviceLabel: text('device_label').notNull(),
    devicePlatform: text('device_platform').notNull(),
    deviceHostname: text('device_hostname'),
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
    expiresIdx: index('desktop_pairing_codes_expires_idx').on(t.expiresAt),
    consumedIdx: index('desktop_pairing_codes_consumed_idx').on(t.consumedAt),
  }),
);

// ISS-305 — Runner browser-approve device-login (OAuth device-authorization
// flow, cf. `claude login`). Kept distinct from `desktopPairingCodes`: that
// flow mints a *user JWT* for the desktop app, whereas this one mints a
// *device token* for the headless `forge-runner` CLI and (optionally)
// provisions a git push credential. Same code-gen + hash + TTL shape so the
// two stay auditable side-by-side.
export const deviceLoginCodes = pgTable(
  'device_login_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull().unique(),
    deviceLabel: text('device_label').notNull(),
    devicePlatform: text('device_platform').notNull(),
    deviceHostname: text('device_hostname'),
    // Stable machine id (sha256 of /etc/machine-id) carried init→approve→issue
    // so browser-approve login dedups by machine like the paste-code flow.
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
  // Notification delivery preference: when false, suppress in-app `mention`
  // notifications for this user (gated in createNotification). `mention` is the
  // only user-initiated notification type currently produced, so it is the only
  // honest opt-out we expose — no fake controls for unimplemented channels.
  notifyOnMention: boolean('notify_on_mention').notNull().default(true),
  // Identity of the newest "What's New" entry this user has seen (the changelog
  // version, or `unreleased:<hash>` for the moving [Unreleased] section). Drives
  // the nav badge: shown while this differs from the current top entry. Nullable
  // — absent means the user has never opened the feed (ISS-384).
  lastSeenWhatsNew: text('last_seen_whats_new'),
  // The org the user is currently "working in" (ISS-469 global org switcher).
  // Nullable — null means no explicit choice yet; the client resolves that to
  // the personal org. `set null` on org delete so a removed org clears the
  // pointer rather than blocking the delete or dangling.
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

// === Organizations (org-level permission tier) ===
//
// Every project belongs to exactly ONE org (`projects.org_id` NOT NULL). Each
// user gets a personal org at signup (and via the 0106 backfill); team orgs are
// created explicitly. Org owner/admin derive an implicit project `admin` role
// on every project in the org; org `member` derives NOTHING — project access
// for plain members still requires a project_members row (or being in a
// project of an org they admin). The single resolution rule lives in
// `lib/authz.ts effectiveProjectRole` — do not re-implement it.

export const orgMemberRoles = ['owner', 'admin', 'member'] as const;
export type OrgMemberRole = (typeof orgMemberRoles)[number];

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

export const jobStatuses = [
  'queued',
  'dispatched',
  'running',
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
    // Pipeline self-healing (Phase H, ISS-306; taxonomy rebuilt by ISS-450 /
    // ISS-442 C4). Set when the job ends in `failed`. failureKind drives the
    // per-class retry policy (code = no retry, transient-cc = immediate
    // device failover, infra/timeout = bounded round-robin). classifierVersion
    // pins the classifier rules at write time so old rows survive future
    // pattern changes without silent reclassification.
    failureKind: text('failure_kind', {
      enum: ['code', 'infra', 'transient-cc', 'timeout'],
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
    activeUniqueIdx: uniqueIndex('jobs_active_unique')
      .on(t.issueId, t.type)
      .where(sql`status IN ('queued','dispatched','running') AND issue_id IS NOT NULL`),
    // PM jobs may have a NULL issue_id (project-scoped coordinator), so the
    // existing per-issue index does not cover them. ISS-17.
    pmActiveUniqueIdx: uniqueIndex('jobs_pm_per_project_unique_idx')
      .on(t.projectId)
      .where(sql`type = 'pm' AND status IN ('queued','dispatched','running')`),
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
export const runnerTypes = ['claude-code', 'antigravity'] as const;
export type RunnerType = (typeof runnerTypes)[number];

export const runnerHosts = ['device', 'remote'] as const;
export type RunnerHost = (typeof runnerHosts)[number];

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
    host: text('host', { enum: runnerHosts }).notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
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
    // Rate-limit / usage-limit / auth highlighting (ported from forge-agents).
    // `limitReason` records why the runner is limited; `rateLimitedUntil` is the
    // parsed reset time for usage/rate limits (NULL for `auth`, which needs a
    // manual fix). All three are cleared on a healthy heartbeat or a job that
    // completes (see heartbeat-ws + finalize-failure). A non-null `limitReason`
    // with `rateLimitedUntil` in the future is the dispatcher's skip signal and
    // the UI's "limited" badge source.
    limitReason: text('limit_reason', { enum: runnerLimitReasons }),
    rateLimitedUntil: timestamp('rate_limited_until', { withTimezone: true }),
    limitDetail: text('limit_detail'),
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
    projectDeviceTypeUq: uniqueIndex('runners_project_device_type_uq')
      .on(t.projectId, t.deviceId, t.type)
      .where(sql`device_id IS NOT NULL`),
    // Remote runners (host='remote', deviceId IS NULL) must be uniquely
    // named per project + type so an operator can't accidentally create
    // duplicate antigravity backends with separate callback secrets.
    remoteNameUq: uniqueIndex('runners_remote_name_uq')
      .on(t.projectId, t.type, t.name)
      .where(sql`host = 'remote'`),
  }),
);

export const runnersRelations = relations(runners, ({ one, many }) => ({
  project: one(projects, { fields: [runners.projectId], references: [projects.id] }),
  device: one(devices, { fields: [runners.deviceId], references: [devices.id] }),
  jobs: many(jobs),
}));

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
] as const;
// `pass`, `staging`, and `deploying` were retired (unify gate model): the single
// production approval gate is `tested` ("Awaiting release") and review exits
// straight to `testing`. All three were removed from the lifecycle entirely;
// one-shot migrations re-parked any stranded issue (pass/staging → tested,
// deploying → testing), so no row can ever hold them again. The `staging`
// *jobType* (schema `jobTypes`) is intentionally kept for back-compat with
// historical `jobs.type='staging'` rows, but maps to no status.
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
    status: text('status', { enum: issueStatuses }).notNull().default('open'),
    priority: text('priority', { enum: issuePriorities }).notNull().default('medium'),
    category: text('category'),
    // Set by webhook/MCP imports; NULL when `createdById` covers the actor.
    reportedBy: text('reported_by'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    parentIssueId: uuid('parent_issue_id'),
    // ISS-232 — git-aware Layer-2 dependency gate. Set by the state-machine
    // (see `issues/merged-at.ts`) when an issue transitions OUT of
    // `pipelineConfig.mergeStates.baseBranch` (default `"released"`). NULL =
    // parent has not yet merged → downstream `kind=blocks` children stay
    // gated by the picker. Operator can UPDATE directly to unblock children
    // of an abandoned issue. Backfilled by migration 0077 for legacy issues
    // already in `released`/`closed` at deploy time.
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    // ISS-42 C2 — t-shirt sizing (xs/s/m/l/xl) for scoping. NULL = unsized.
    complexity: text('complexity', { enum: issueComplexities }),
    reopenCount: integer('reopen_count').notNull().default(0),
    source: text('source', { enum: issueSources }).notNull().default('manual'),
    externalId: text('external_id'),
    // ISS-293: extension fields used by the autonomous /forge-* skill pipeline
    // (forge-plan writes plan, forge-clarify reads acceptanceCriteria, etc.).
    // Migration 0031.
    plan: text('plan'),
    acceptanceCriteria: text('acceptance_criteria'),
    suggestedSolution: text('suggested_solution'),
    sessionContext: jsonb('session_context'),
    // ISS-59 — AI enrichment fields. Populated by the skill pipeline
    // (forge-clarify / forge-plan) via the MCP forge_issues.update tool.
    // Read-only from REST clients. Migration 0048.
    aiSummary: text('ai_summary'),
    aiSuggestedSolution: text('ai_suggested_solution'),
    aiAcceptanceCriteria: jsonb('ai_acceptance_criteria').$type<string[]>(),
    aiConfidence: real('ai_confidence'),
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
          // ISS-138 (PR-D) — opt-out flag for the decomposition helper.
          // Defaults to true (helper creates the shared integration branch).
          useIntegrationBranch?: boolean;
        } & Record<string, unknown>)
      | null
    >(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIssSeqUq: uniqueIndex('issues_project_iss_seq_uq').on(t.projectId, t.issSeq),
    projectStatusIdx: index('issues_project_status_idx').on(t.projectId, t.status),
    assigneeIdx: index('issues_assignee_idx').on(t.assigneeId),
    projectSourceExternalIdUq: uniqueIndex('issues_project_source_external_id_uq')
      .on(t.projectId, t.source, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    parentFk: foreignKey({
      columns: [t.parentIssueId],
      foreignColumns: [t.id],
      name: 'issues_parent_issue_id_fk',
    }).onDelete('set null'),
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
    parentId: uuid('parent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('comments_issue_id_idx').on(t.issueId),
    parentIdx: index('comments_parent_id_idx').on(t.parentId),
    parentFk: foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: 'comments_parent_id_fk',
    }).onDelete('cascade'),
  }),
);

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectNameUq: uniqueIndex('labels_project_id_name_uq').on(t.projectId, t.name),
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
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.labelId] }),
    labelIdx: index('issue_labels_label_id_idx').on(t.labelId),
  }),
);

export const actorTypes = ['user', 'device'] as const;
export type ActorType = (typeof actorTypes)[number];

export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorType: text('actor_type', { enum: actorTypes }).notNull(),
    actorId: uuid('actor_id').notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueCreatedIdx: index('activity_log_issue_created_idx').on(t.issueId, t.createdAt),
  }),
);

export const issuesRelations = relations(issues, ({ one, many }) => ({
  project: one(projects, { fields: [issues.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [issues.assigneeId], references: [users.id] }),
  createdBy: one(users, { fields: [issues.createdById], references: [users.id] }),
  parent: one(issues, {
    fields: [issues.parentIssueId],
    references: [issues.id],
    relationName: 'issue_parent',
  }),
  children: many(issues, { relationName: 'issue_parent' }),
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
  issues: many(issueLabels),
}));

export const issueLabelsRelations = relations(issueLabels, ({ one }) => ({
  issue: one(issues, { fields: [issueLabels.issueId], references: [issues.id] }),
  label: one(labels, { fields: [issueLabels.labelId], references: [labels.id] }),
}));

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  issue: one(issues, { fields: [activityLog.issueId], references: [issues.id] }),
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
    // ISS-605 template lineage: which global template this project copy was
    // adopted from, and at which template version. NULL version on a row with
    // a lineage id = adopted before tracking (unknown) — the drift sweep
    // treats it as behind-template. Plain uuid (no FK): a deleted template
    // must not cascade into project copies.
    basedOnGlobalSkillId: uuid('based_on_global_skill_id'),
    basedOnGlobalVersion: integer('based_on_global_version'),
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

// Skill Studio 4 (ISS-278) — tracks which skill version each device holds for
// each project. The server is the source of truth (`skills` + overrides +
// registrations); a row here records the `installedHash` the runner last
// reported after seeding `.claude/skills/<name>/` onto disk. `outdated` is
// derived by comparing `installedHash` against the project's effective hash
// (`hashSkillBody(effectiveMd, files)`) — never stored, always recomputed.
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

export const MEMORY_EMBEDDING_DIM = 1536;

/**
 * Postgres full-text search vector. Generated column — never written by the
 * app; Postgres derives it from `text_content`. Read via `@@` / `ts_rank` in
 * the keyword retrieval strategy (memory-v2 phase 1).
 */
const tsVector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

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

export const scheduleRunners = ['desktop', 'antigravity'] as const;
export type ScheduleRunner = (typeof scheduleRunners)[number];

export const scheduleStatuses = ['success', 'failed', 'running', 'skipped'] as const;
export type ScheduleStatus = (typeof scheduleStatuses)[number];

export const scheduleModes = ['propose', 'auto'] as const;
export type ScheduleMode = (typeof scheduleModes)[number];

// ISS-618 — a schedule can fire a standalone sandboxed script instead of
// dispatching a Claude agent session. 'prompt' is the pre-existing behavior.
export const scheduleKinds = ['prompt', 'script'] as const;
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
    runner: text('runner', { enum: scheduleRunners }).notNull().default('antigravity'),
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
    // ISS-510 — auto-resolve linkage. A problem notification carries a stable
    // per-condition key (e.g. `issue:<id>:status`); when the condition clears
    // (issue reaches a healthy status) the resolver marks every matching unread
    // row read and stamps `resolvedAt`. Both nullable — most rows carry neither.
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
    // agent_session_id is intentionally a bare uuid (no FK) until the agent_sessions
    // table lands in a later B2 migration — adding the FK then is additive.
    agentSessionId: uuid('agent_session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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

// Terminal cause written to `agent_sessions.failure_reason`. Reserved for
// actual session execution failures (zombie sweeper, worker errors, user
// cancellation). Dispatcher gate skips (issue_busy/waiting_on_dep/
// project_full/runner_full/manual_hold) are recomputed by the picker on
// every tick (ISS-162 Stateless Gates) — no persisted gate state lives on
// the session row, and the picker itself filters gated jobs out of its
// SELECT.
export const agentSessionFailureReasons = [
  'queue_timeout',
  'heartbeat_timeout',
  'no_worker_online',
  'user_cancelled',
  'job_failed',
  'migration_zombie_cleanup',
] as const;
export type AgentSessionFailureReason = (typeof agentSessionFailureReasons)[number];

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
    // ISS-34 zombie-fix lifecycle stamps. `dispatchedAt` is set when the
    // pipeline enqueues; `startedAt` when a worker actually claims (CAS from
    // queued → running); `lastHeartbeatAt` is bumped on every worker write
    // (message append, claudeSessionId set, status patch). `failureReason`
    // is a free-form text column whose canonical values are listed in
    // `agentSessionFailureReasons` above (terminal causes from ISS-34 plus
    // ISS-40 PR-E dispatcher skip reasons).
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
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
export const appConfig = pgTable('app_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  chatProviderId: text('chat_provider_id'),
  chatModel: text('chat_model'),
  retrievalTopK: integer('retrieval_top_k').notNull().default(10),
  retrievalMinScore: real('retrieval_min_score').notNull().default(0),
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

// ===== PM Agent (ISS-17) =====================================================
// Stateless coordinator agent supplementing the per-issue pipeline. See parent
// epic ISS-16 and `.forge/pm-agent-requirements.md` for the design. Tables:
//   - issue_dependencies: cross-issue edges (blocks/relates/duplicates/parent)
//   - pm_decisions:       audit log of every PM session output
//   - pm_config:          per-project enable/cadence/triggers (one row/project)
//   - pm_policies:        free-text Markdown policies, embedded for retrieval
//
// Dispatcher convention (ISS-40 PR-E Layer 2): only rows with `kind='blocks'`
// gate dispatch. An edge `(from=A, to=B, kind='blocks')` means **A must
// reach a terminal status (`released`/`closed`) before B
// can dispatch**. Other kinds (`relates`, `duplicates`, `parent`) are PM/UX
// metadata only and do not affect dispatch. Cross-project edges are allowed.
// The `decomposes` kind (epic→child) engages a separate decomposition
// lifecycle (cascade approve on parent waiting→approved, watcher when all
// children reach staging, atomic release gate on child release jobs, close
// cascade on parent→closed). See `pipeline/decomposition.ts` and
// `pipeline/decomposition-subscribers.ts`.

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

// Per-project git SSH credential (optional). A deploy-key-style keypair shared
// by every device bound to the project — generate once, add the public key to
// the repo, and any number of runners can clone/push without per-device setup.
// `forge_generated` => Forge minted the ed25519 pair (private encrypted here,
// public surfaced for the user to add as a deploy key); `user_provided` => the
// user pasted their own private key (encrypted the same way). The private key
// is delivered to a runner once over the wire during provision (mirrors the
// ISS-305 git-credential side-channel) and never re-read in plaintext server-side.
export const projectGitCredentialSources = ['forge_generated', 'user_provided'] as const;
export type ProjectGitCredentialSource = (typeof projectGitCredentialSources)[number];

export const projectGitCredentials = pgTable('project_git_credentials', {
  // 1:1 with the project — PK is the FK so a project has at most one credential.
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  source: text('source', { enum: projectGitCredentialSources }).notNull(),
  // Non-secret OpenSSH public key line ("ssh-ed25519 AAAA… forge-<slug>").
  publicKey: text('public_key').notNull(),
  // Vault-encrypted (<iv:12><tag:16><ct>) OpenSSH private key — same format as
  // integration_connections.secrets_enc; decrypt only at provision dispatch.
  privateKeyEnc: bytea('private_key_enc').notNull(),
  // Non-secret SHA256 fingerprint for display ("SHA256:…").
  fingerprint: text('fingerprint'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectGitCredentialsRelations = relations(projectGitCredentials, ({ one }) => ({
  project: one(projects, {
    fields: [projectGitCredentials.projectId],
    references: [projects.id],
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

// === Connection / Binding model (docs/integrations/connection-binding.md) ===
//
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

// ISS-381 (2.1) — unified structured verdict promoted out of the handoff
// payload. Maps the review handoff `verdict` (pass/needs_fix/no_change) and the
// test handoff `result` (pass/fail) onto one queryable enum; `abstain` is
// reserved for a review that could not run.
export const stepVerdicts = ['pass', 'fail', 'needs_fix', 'no_change', 'abstain'] as const;
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
  }),
);

export const feedbackReportsRelations = relations(feedbackReports, ({ one }) => ({
  project: one(projects, { fields: [feedbackReports.projectId], references: [projects.id] }),
  issue: one(issues, { fields: [feedbackReports.issueId], references: [issues.id] }),
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

// ─── UX Contract ────────────────────────────────────────────────────────────
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
