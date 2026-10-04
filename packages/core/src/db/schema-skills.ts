import { relations, sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { devices } from './schema-devices.js';
import { projects } from './schema-projects.js';
import { skillActivityEventTypes, skillActivityTriggers } from './skill-activity-vocabulary.js';

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

export const skillsRelations = relations(skills, ({ one }) => ({
  project: one(projects, { fields: [skills.projectId], references: [projects.id] }),
}));
