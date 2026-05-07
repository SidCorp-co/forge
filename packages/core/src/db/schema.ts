import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

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
  isCeo: boolean('is_ceo').notNull().default(false),
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

// Cross-process PKCE handoff for the desktop client (ADR 0017). Holds the
// transient state between /auth/desktop/start and /auth/desktop/exchange so
// the desktop process can claim a JWT without ever exposing one in a URL.
export const oauthHandoff = pgTable(
  'oauth_handoff',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeHash: text('code_hash'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index('oauth_handoff_expires_idx').on(t.expiresAt),
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

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    description: text('description'),
    repoPath: text('repo_path'),
    baseBranch: text('base_branch'),
    productionBranch: text('production_branch'),
    defaultDeviceId: uuid('default_device_id').references((): AnyPgColumn => devices.id, {
      onDelete: 'set null',
    }),
    agentConfig: jsonb('agent_config'),
    webhookSecret: text('webhook_secret'),
    apiKey: text('api_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdIdx: index('projects_owner_id_idx').on(t.ownerId),
    apiKeyUq: uniqueIndex('projects_api_key_uq')
      .on(t.apiKey)
      .where(sql`api_key IS NOT NULL`),
    defaultDeviceIdx: index('projects_default_device_id_idx').on(t.defaultDeviceId),
  }),
);

export const projectMemberRoles = ['owner', 'admin', 'member'] as const;
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

export const projectDevices = pgTable(
  'project_devices',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references((): AnyPgColumn => devices.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.deviceId] }),
    deviceIdIdx: index('project_devices_device_id_idx').on(t.deviceId),
  }),
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
  members: many(projectMembers),
  defaultDevice: one(devices, {
    fields: [projects.defaultDeviceId],
    references: [devices.id],
  }),
  devicePool: many(projectDevices),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const projectDevicesRelations = relations(projectDevices, ({ one }) => ({
  project: one(projects, { fields: [projectDevices.projectId], references: [projects.id] }),
  device: one(devices, { fields: [projectDevices.deviceId], references: [devices.id] }),
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
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    pairedAt: timestamp('paired_at', { withTimezone: true }).notNull().defaultNow(),
    capabilities: jsonb('capabilities'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdIdx: index('devices_owner_id_idx').on(t.ownerId),
    tokenPrefixIdx: index('devices_token_prefix_idx').on(t.tokenPrefix),
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
  'release',
  'fix',
  'custom',
  'pm',
] as const;
export type JobType = (typeof jobTypes)[number];

export const modelTiers = ['haiku', 'sonnet', 'opus'] as const;
export type ModelTier = (typeof modelTiers)[number];

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    // EPIC 2 (ISS-271): nullable runner FK. Dispatcher writes both deviceId
    // and runnerId for runnerFramework=on; only deviceId for legacy path.
    runnerId: uuid('runner_id').references((): AnyPgColumn => runners.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text('type', { enum: jobTypes }).notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status', { enum: jobStatuses }).notNull().default('queued'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    error: text('error'),
    modelTier: text('model_tier', { enum: modelTiers }),
    attempts: integer('attempts').notNull().default(1),
    maxAttempts: integer('max_attempts').notNull().default(3),
    cancellationRequested: boolean('cancellation_requested').notNull().default(false),
    retryOf: uuid('retry_of').references((): AnyPgColumn => jobs.id, { onDelete: 'set null' }),
    // ISS-4: link to the observability `agent_sessions` row created by the
    // dispatcher so /pipeline + issue detail surfaces can render pipeline
    // jobs alongside interactive sessions. Bare uuid (no FK) to match the
    // notifications.agent_session_id pattern — adding the FK later is additive.
    agentSessionId: uuid('agent_session_id'),
    // Pipeline self-healing (Phase H, ISS-306). Set when the job ends in
    // `failed`. failureKind drives whether the issue-state sweeper should
    // re-fire (transient/unknown) or escalate (permanent). classifierVersion
    // pins the classifier rules at write time so old rows survive future
    // pattern changes without silent reclassification.
    failureKind: text('failure_kind', { enum: ['transient', 'permanent', 'unknown'] }),
    failureReason: text('failure_reason'),
    failureMeta: jsonb('failure_meta'),
    classifierVersion: integer('classifier_version'),
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
  }),
);

export const jobEventKinds = [
  'stdout',
  'stderr',
  'tool_call',
  'tool_result',
  'progress',
  'result',
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
  events: many(jobEvents),
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
    status: text('status', { enum: runnerStatuses }).notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectTypeStatusIdx: index('runners_project_type_status_idx').on(
      t.projectId,
      t.type,
      t.status,
    ),
    deviceIdIdx: uniqueIndex('runners_device_type_uq')
      .on(t.deviceId, t.type)
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
  'waiting',
  'approved',
  'in_progress',
  'developed',
  'deploying',
  'testing',
  'tested',
  'pass',
  'staging',
  'released',
  'closed',
  'reopen',
  'on_hold',
  'needs_info',
  // Pipeline self-healing (Phase H, ISS-306). Set by the sweeper when an
  // issue exhausts its recovery budget OR hits a permanent failure (content
  // filter, auth, validation). Distinguishes "agent gave up" from
  // `needs_info` ("agent asked the human a question") so dashboards,
  // reporting, and notification routing can treat the two cases separately.
  'pipeline_failed',
] as const;
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
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    parentIssueId: uuid('parent_issue_id'),
    // ISS-42 C1 — when true the dispatcher's Layer 1 short-circuits with
    // skip-reason 'manual_hold' so no new automation jobs spawn for this
    // issue. In-flight jobs are not killed.
    manualHold: boolean('manual_hold').notNull().default(false),
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
    // Pipeline self-healing (Phase H, ISS-306). The sweeper increments
    // recoveryAttempts every time it re-fires the orchestrator for this
    // issue. lastRecoveryAt anchors the sliding window; once
    // (now - recoveryWindowStartedAt) exceeds the project's configured
    // window (default 24h) the counter auto-resets so a one-off bad day
    // doesn't condemn an issue forever.
    recoveryAttempts: integer('recovery_attempts').notNull().default(0),
    lastRecoveryAt: timestamp('last_recovery_at', { withTimezone: true }),
    recoveryWindowStartedAt: timestamp('recovery_window_started_at', { withTimezone: true }),
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
    // Sweeper queries `WHERE status IN (...pipeline) ORDER BY last_recovery_at`
    // to avoid revisiting the same recently-recovered issue every tick.
    pipelineRecoveryIdx: index('issues_pipeline_recovery_idx').on(t.status, t.lastRecoveryAt),
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
    name: text('name').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    commentIdx: index('comment_attachments_comment_id_idx').on(t.commentId),
  }),
);

export const commentAttachmentsRelations = relations(commentAttachments, ({ one }) => ({
  comment: one(comments, { fields: [commentAttachments.commentId], references: [comments.id] }),
  uploader: one(users, { fields: [commentAttachments.uploaderId], references: [users.id] }),
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

// v1 EPIC 6 — per-project override of a global skill's `skill_md`. The CRUD
// surface is `/api/projects/:projectId/skills/:skillId/override`; the merged
// view is exposed via `/api/projects/:projectId/skills/effective`. The unique
// (project_id, skill_id) constraint enforces "at most one override per
// (project, global skill)" — clients PUT to upsert, DELETE to revert.
export const projectSkillOverrides = pgTable(
  'project_skill_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    skillMdOverride: text('skill_md_override').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSkillUq: uniqueIndex('project_skill_overrides_project_skill_uq').on(
      t.projectId,
      t.skillId,
    ),
    projectIdx: index('project_skill_overrides_project_id_idx').on(t.projectId),
    skillIdx: index('project_skill_overrides_skill_id_idx').on(t.skillId),
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
    embedding: pgVector(MEMORY_EMBEDDING_DIM)('embedding').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
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

export const projectSkillOverridesRelations = relations(projectSkillOverrides, ({ one }) => ({
  project: one(projects, {
    fields: [projectSkillOverrides.projectId],
    references: [projects.id],
  }),
  skill: one(skills, { fields: [projectSkillOverrides.skillId], references: [skills.id] }),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  project: one(projects, { fields: [memories.projectId], references: [projects.id] }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('tasks_issue_id_idx').on(t.issueId),
    projectStatusIdx: index('tasks_project_status_idx').on(t.projectId, t.status),
    assigneeIdx: index('tasks_assignee_idx').on(t.assigneeId),
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

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    prompt: text('prompt').notNull(),
    runner: text('runner', { enum: scheduleRunners }).notNull().default('antigravity'),
    enabled: boolean('enabled').notNull().default(true),
    targetProjectSlug: text('target_project_slug'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastStatus: text('last_status', { enum: scheduleStatuses }),
    lastSessionId: text('last_session_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectEnabledIdx: index('schedules_project_enabled_idx').on(t.projectId, t.enabled),
    nextRunAtIdx: index('schedules_next_run_at_idx').on(t.nextRunAt).where(sql`enabled = true`),
  }),
);

export const schedulesRelations = relations(schedules, ({ one }) => ({
  project: one(projects, { fields: [schedules.projectId], references: [projects.id] }),
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
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRecordedIdx: index('usage_records_project_recorded_idx').on(t.projectId, t.recordedAt),
    sessionIdIdx: index('usage_records_session_id_idx').on(t.sessionId),
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
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
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

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    widgetUserId: text('widget_user_id'),
    userKey: text('user_key'),
    title: text('title'),
    source: text('source', { enum: chatSessionSources }).notNull().default('web'),
    messages: jsonb('messages').notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb('metadata'),
    summary: text('summary'),
    summarizedAt: timestamp('summarized_at', { withTimezone: true }),
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

export const agentSessionStatuses = ['idle', 'queued', 'running', 'completed', 'failed'] as const;
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];

// Terminal/skip cause written to `agent_sessions.failure_reason`. The column
// itself stays plain `text` (no DB CHECK constraint) — this tuple is the
// canonical TS-side enum referenced by the dispatcher, the queued-watchdog,
// and web sidebar tooltips. Adding a new reason here without writing it from
// somewhere is harmless; the sidebar falls back to a generic label for
// unknown values (forward-compat).
export const agentSessionFailureReasons = [
  // ISS-34 zombie sweeper + lifecycle terminal causes.
  'queue_timeout',
  'heartbeat_timeout',
  'no_worker_online',
  'user_cancelled',
  'job_failed',
  'migration_zombie_cleanup',
  // ISS-40 PR-E dispatcher gating skip-reasons. Sessions stay queued — the
  // job row is NOT moved to failed, only the surface signal is updated so
  // the UI can explain why the session hasn't started yet.
  'issue_busy',
  'waiting_on_dep',
  'project_full',
  'runner_full',
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
    title: text('title'),
    status: text('status', { enum: agentSessionStatuses }).notNull().default('idle'),
    messages: jsonb('messages').notNull().default(sql`'[]'::jsonb`),
    claudeSessionId: text('claude_session_id'),
    repoPath: text('repo_path'),
    usage: jsonb('usage'),
    metadata: jsonb('metadata'),
    diff: jsonb('diff'),
    pipelineControl: jsonb('pipeline_control').$type<import('../agent-sessions/pipeline-control-types.js').PipelineControl | null>(),
    pipelineTelemetry: jsonb('pipeline_telemetry'),
    pipelineHealth: jsonb('pipeline_health').$type<import('../agent-sessions/pipeline-control-types.js').PipelineHealth | null>(),
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
    statusHeartbeatIdx: index('agent_sessions_status_heartbeat_idx').on(t.status, t.lastHeartbeatAt),
    statusDispatchedIdx: index('agent_sessions_status_dispatched_idx').on(t.status, t.dispatchedAt),
  }),
);

export const agentSessionsRelations = relations(agentSessions, ({ one }) => ({
  project: one(projects, { fields: [agentSessions.projectId], references: [projects.id] }),
  user: one(users, { fields: [agentSessions.userId], references: [users.id] }),
  device: one(devices, { fields: [agentSessions.deviceId], references: [devices.id] }),
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
// reach a terminal status (`released`/`closed`/`pipeline_failed`) before B
// can dispatch**. Other kinds (`relates`, `duplicates`, `parent`) are PM/UX
// metadata only and do not affect dispatch. Cross-project edges are allowed.

export const issueDependencyKinds = ['blocks', 'relates', 'duplicates', 'parent'] as const;
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
  eventTriggers: jsonb('event_triggers').notNull().default(
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
