import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { issues } from './schema-issues.js';
import { integrationBindings } from './schema-project-config.js';
import { projects } from './schema-projects.js';

export const pullRequestStates = ['open', 'closed', 'merged'] as const;
export type PullRequestState = (typeof pullRequestStates)[number];

const PR_STATE_CHK = sql`state IN ('open', 'closed', 'merged')`;

export const changeRequestHosts = ['github', 'gitlab'] as const;
export type ChangeRequestHost = (typeof changeRequestHosts)[number];

const PR_HOST_CHK = sql`host IN ('github', 'gitlab')`;

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
    host: text('host', { enum: changeRequestHosts }).notNull().default('github'),
    /** The number the host shows: a GitHub pull request number, or a GitLab merge request iid. */
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
    projectStateIdx: index('repo_pull_requests_project_state_idx').on(t.projectId, t.state),
    baseIdx: index('repo_pull_requests_base_idx').on(t.bindingId, t.baseRef, t.state),
    stateChk: check('repo_pull_requests_state_chk', PR_STATE_CHK),
    hostChk: check('repo_pull_requests_host_chk', PR_HOST_CHK),
  }),
);

export const repoPullRequestsRelations = relations(repoPullRequests, ({ one }) => ({
  project: one(projects, { fields: [repoPullRequests.projectId], references: [projects.id] }),
  binding: one(integrationBindings, {
    fields: [repoPullRequests.bindingId],
    references: [integrationBindings.id],
  }),
}));

/** How a change request came to deliver an issue: its branch names it, or its description does. */
export const changeRequestLinkKinds = ['head-ref', 'description'] as const;
export type ChangeRequestLinkKind = (typeof changeRequestLinkKinds)[number];

const LINKED_BY_CHK = sql`linked_by IN ('head-ref', 'description')`;

/**
 * Every issue a change request delivers (REQ-63 BC-4): one row per issue its branch or its
 * description names, rewritten whole on each delivery, so a key taken out of the description
 * unlinks it. Merging the request stamps every issue linked here.
 */
export const repoPullRequestIssues = pgTable(
  'repo_pull_request_issues',
  {
    pullRequestId: uuid('pull_request_id')
      .notNull()
      .references(() => repoPullRequests.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    linkedBy: text('linked_by', { enum: changeRequestLinkKinds }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'repo_pull_request_issues_pk', columns: [t.pullRequestId, t.issueId] }),
    issueIdx: index('repo_pull_request_issues_issue_idx').on(t.issueId),
    linkedByChk: check('repo_pull_request_issues_linked_by_chk', LINKED_BY_CHK),
  }),
);
