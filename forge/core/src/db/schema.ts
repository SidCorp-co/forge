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
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  isCeo: boolean('is_ceo').notNull().default(false),
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
    activeUniqueIdx: uniqueIndex('jobs_active_unique')
      .on(t.issueId, t.type)
      .where(sql`status IN ('queued','dispatched','running') AND issue_id IS NOT NULL`),
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
    reopenCount: integer('reopen_count').notNull().default(0),
    source: text('source', { enum: issueSources }).notNull().default('manual'),
    externalId: text('external_id'),
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

export const commentsRelations = relations(comments, ({ one, many }) => ({
  issue: one(issues, { fields: [comments.issueId], references: [issues.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
  attachments: many(commentAttachments),
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

export const memorySources = ['issue', 'comment', 'job', 'note', 'knowledge'] as const;
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
    projectPredicateIdx: index('knowledge_edges_project_predicate_idx').on(t.projectId, t.predicate),
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
