import type { InferSelectModel } from 'drizzle-orm';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { integrationBindings, projects, users } from './schema.js';

/**
 * The eight steps, in the order they run — the same eight a person does by hand
 * today, which is the count ISS-1062 recorded as "eight steps done by hand
 * today, one of them done wrong".
 *
 * The first five are reads and can be taken again; `cut_tag` is the only
 * irreversible one; the last two happen on a delivery rather than on the call.
 */
export const RUNNER_RELEASE_STEPS = [
  'resolve_repository',
  'resolve_commit',
  'check_tag_absent',
  'check_crate_version',
  'check_lockfile_version',
  'cut_tag',
  'await_build',
  'confirm_release',
] as const;
export type RunnerReleaseStep = (typeof RUNNER_RELEASE_STEPS)[number];

/** Where the operation is. `published` and `failed` are the terminal pair. */
export const RUNNER_RELEASE_STATUSES = [
  'preflight',
  'cutting',
  'building',
  'published',
  'failed',
] as const;
export type RunnerReleaseStatus = (typeof RUNNER_RELEASE_STATUSES)[number];

export const RUNNER_RELEASE_TAG_STATES = ['unread', 'absent', 'unknown', 'present'] as const;
export type RunnerReleaseTagState = (typeof RUNNER_RELEASE_TAG_STATES)[number];

export const RUNNER_RELEASE_PUBLICATIONS = [
  'unread',
  'absent',
  'incomplete',
  'published',
  'unknown',
] as const;
export type RunnerReleasePublication = (typeof RUNNER_RELEASE_PUBLICATIONS)[number];

const STATUS_CHK = sql`status IN ('preflight', 'cutting', 'building', 'published', 'failed')`;
const TAG_STATE_CHK = sql`tag_state IN ('unread', 'absent', 'unknown', 'present')`;
const SETTLED_CHK = sql`(status IN ('published', 'failed')) = (settled_at IS NOT NULL)`;
const PUBLISHED_CHK = sql`status <> 'published' OR (tag_state = 'present' AND publication = 'published')`;
const ATTEMPT_CHK = sql`attempt >= 1`;

export const runnerReleases = pgTable(
  'runner_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => integrationBindings.id, { onDelete: 'cascade' }),
    /** `owner/repo`, as the binding spelled it when the release was opened. */
    repository: text('repository').notNull(),
    /** The bare version, e.g. `0.13.3`. */
    version: text('version').notNull(),
    /** `runner-v` + the version. Unique per project, because a tag is immutable. */
    tag: text('tag').notNull(),
    attempt: integer('attempt').notNull().default(1),
    /** The commit this release resolved and would cut at. NULL until `resolve_commit` answered. */
    commitSha: text('commit_sha'),
    tagCommitSha: text('tag_commit_sha'),
    status: text('status', { enum: RUNNER_RELEASE_STATUSES }).notNull().default('preflight'),
    /** The step the operation is at, or the step it stopped at. */
    step: text('step', { enum: RUNNER_RELEASE_STEPS }).notNull().default('resolve_repository'),
    tagState: text('tag_state', { enum: RUNNER_RELEASE_TAG_STATES }).notNull().default('unread'),
    publication: text('publication', { enum: RUNNER_RELEASE_PUBLICATIONS })
      .notNull()
      .default('unread'),
    /** What the publication reading saw: which assets are there and which are not. */
    publicationDetail: text('publication_detail'),
    /** GitHub's own id for the build this release is reported from. */
    workflowRunId: text('workflow_run_id'),
    workflowUrl: text('workflow_url'),
    buildConclusion: text('build_conclusion'),
    releaseUrl: text('release_url'),
    /** Which step failed and what is now true on the repository. One sentence. */
    failure: text('failure'),
    readings: jsonb('readings').notNull().default([]).$type<string[]>(),
    requestedById: uuid('requested_by_id').references(() => users.id, { onDelete: 'set null' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** When GitHub confirmed the tag ref. NULL beside `tag_state = 'unknown'` is the mid-write death. */
    tagCutAt: timestamp('tag_cut_at', { withTimezone: true }),
    buildReportedAt: timestamp('build_reported_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectTagUq: uniqueIndex('runner_releases_project_tag_uq').on(t.projectId, t.tag),
    bindingTagIdx: index('runner_releases_binding_tag_idx').on(t.bindingId, t.tag),
    projectStatusIdx: index('runner_releases_project_status_idx').on(t.projectId, t.status),
    deadlineIdx: index('runner_releases_deadline_idx')
      .on(t.deadlineAt)
      .where(sql`settled_at IS NULL`),
    statusChk: check('runner_releases_status_chk', STATUS_CHK),
    tagStateChk: check('runner_releases_tag_state_chk', TAG_STATE_CHK),
    settledChk: check('runner_releases_settled_chk', SETTLED_CHK),
    publishedChk: check('runner_releases_published_chk', PUBLISHED_CHK),
    attemptChk: check('runner_releases_attempt_chk', ATTEMPT_CHK),
  }),
);

export const runnerReleasesRelations = relations(runnerReleases, ({ one }) => ({
  project: one(projects, { fields: [runnerReleases.projectId], references: [projects.id] }),
  binding: one(integrationBindings, {
    fields: [runnerReleases.bindingId],
    references: [integrationBindings.id],
  }),
  requestedBy: one(users, { fields: [runnerReleases.requestedById], references: [users.id] }),
}));

export type RunnerReleaseRow = InferSelectModel<typeof runnerReleases>;
