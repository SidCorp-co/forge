import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    agentConfig: jsonb('agent_config'),
    webhookSecret: text('webhook_secret'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdIdx: index('projects_owner_id_idx').on(t.ownerId),
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

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
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
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('pairing_codes_user_id_idx').on(t.userId),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdx: index('jobs_project_id_idx').on(t.projectId),
    deviceIdIdx: index('jobs_device_id_idx').on(t.deviceId),
    issueIdIdx: index('jobs_issue_id_idx').on(t.issueId),
    statusIdx: index('jobs_status_idx').on(t.status),
    retryOfIdx: index('jobs_retry_of_idx').on(t.retryOf),
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
  createdByUser: one(users, { fields: [jobs.createdBy], references: [users.id] }),
  events: many(jobEvents),
}));

export const jobEventsRelations = relations(jobEvents, ({ one }) => ({
  job: one(jobs, { fields: [jobEvents.jobId], references: [jobs.id] }),
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
] as const;
export type IssueStatus = (typeof issueStatuses)[number];

export const issuePriorities = ['critical', 'high', 'medium', 'low', 'none'] as const;
export type IssuePriority = (typeof issuePriorities)[number];

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
    reopenCount: integer('reopen_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIssSeqUq: uniqueIndex('issues_project_iss_seq_uq').on(t.projectId, t.issSeq),
    projectStatusIdx: index('issues_project_status_idx').on(t.projectId, t.status),
    assigneeIdx: index('issues_assignee_idx').on(t.assigneeId),
    parentFk: foreignKey({
      columns: [t.parentIssueId],
      foreignColumns: [t.id],
      name: 'issues_parent_issue_id_fk',
    }).onDelete('set null'),
  }),
);

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('comments_issue_id_idx').on(t.issueId),
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

export const commentsRelations = relations(comments, ({ one }) => ({
  issue: one(issues, { fields: [comments.issueId], references: [issues.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
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
