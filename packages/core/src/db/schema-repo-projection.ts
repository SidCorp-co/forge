import { relations, sql } from 'drizzle-orm';
import {
  boolean,
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
import { integrationBindings, issues, projects } from './schema.js';

export const pullRequestStates = ['open', 'closed', 'merged'] as const;
export type PullRequestState = (typeof pullRequestStates)[number];

const PR_STATE_CHK = sql`state IN ('open', 'closed', 'merged')`;

export interface ProjectedCheckRun {
  /** GitHub's `check_run.id`, as a string. Also the map key. */
  id: string;
  name: string;
  /** `check_run.app.slug`, or `unknown` where GitHub sent none. Half of the rollup's group key. */
  app: string;
  /** The head this run ran on. The rollup counts only runs matching the row's `head_sha`. */
  headSha: string;
  /** `queued` | `in_progress` | `completed`, and monotone in that order. */
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ProjectedReview {
  /** GitHub's `pull_request_review.id`, as a string. Also the map key. */
  id: string;
  reviewer: string;
  /** `approved` | `changes_requested` | `commented`, as GitHub spells it. */
  state: string;
  submittedAt: string | null;
  dismissed: boolean;
  url: string | null;
}

/** The `checks` column's shape: run id → run. */
export type ProjectedChecks = Record<string, ProjectedCheckRun>;
/** The `reviews` column's shape: review id → review. */
export type ProjectedReviews = Record<string, ProjectedReview>;

export const repoPullRequests = pgTable(
  'repo_pull_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => integrationBindings.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    number: integer('number').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    title: text('title').notNull(),
    htmlUrl: text('html_url'),
    state: text('state', { enum: pullRequestStates }).notNull(),
    draft: boolean('draft').notNull().default(false),
    headRef: text('head_ref').notNull(),
    headSha: text('head_sha').notNull(),
    baseRef: text('base_ref').notNull(),
    baseSha: text('base_sha').notNull(),
    behindBy: integer('behind_by'),
    aheadBy: integer('ahead_by'),
    mergeable: boolean('mergeable'),
    mergeableState: text('mergeable_state'),
    refreshedForHead: text('refreshed_for_head'),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
    refreshError: text('refresh_error'),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergeCommitSha: text('merge_commit_sha'),
    checks: jsonb('checks').notNull().default({}).$type<ProjectedChecks>(),
    reviews: jsonb('reviews').notNull().default({}).$type<ProjectedReviews>(),
    payloadUpdatedAt: timestamp('payload_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bindingNumberUq: uniqueIndex('repo_pull_requests_binding_number_uq').on(t.bindingId, t.number),
    issueIdx: index('repo_pull_requests_issue_idx').on(t.issueId),
    projectStateIdx: index('repo_pull_requests_project_state_idx').on(t.projectId, t.state),
    baseIdx: index('repo_pull_requests_base_idx').on(t.bindingId, t.baseRef, t.state),
    stateChk: check('repo_pull_requests_state_chk', PR_STATE_CHK),
  }),
);

export const repoPullRequestsRelations = relations(repoPullRequests, ({ one }) => ({
  project: one(projects, { fields: [repoPullRequests.projectId], references: [projects.id] }),
  binding: one(integrationBindings, {
    fields: [repoPullRequests.bindingId],
    references: [integrationBindings.id],
  }),
  issue: one(issues, { fields: [repoPullRequests.issueId], references: [issues.id] }),
}));
