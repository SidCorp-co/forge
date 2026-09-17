// The projection of a repository's pull requests, per project.
//
// Forge's model of the code was a claim and is a projection here: everything it
// manages describes work whose substance lives in git, and what it actually
// knew about git was one caller-asserted boolean (`issues.merged_at`) and a
// branch name in `session_context`. Whether a branch is behind, whether its
// checks passed, whether a review is open, whether it conflicts: none of it was
// held anywhere, so every agent re-derived all of it by shelling out to `gh`
// under a person's account (ISS-1062).
//
// Split out of `schema.ts` for size, like `schema-conversations.ts`, and
// registered in `drizzle.config.ts` and the client's schema map beside it.

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

// cm:guard `merged` is a THIRD state and not a flag on `closed` — GitHub closes a pull request for `wontfix` and for a landing with the same event, and the whole reason this projection exists is that Forge could not tell those apart. Collapsing it back to a boolean is the shape ISS-1062 replaced.
export const pullRequestStates = ['open', 'closed', 'merged'] as const;
export type PullRequestState = (typeof pullRequestStates)[number];

const PR_STATE_CHK = sql`state IN ('open', 'closed', 'merged')`;

/**
 * One check run as GitHub reported it, keyed in `checks` by GitHub's own id for
 * that run.
 *
 * Keyed by run id and never by name: a re-run of `ci-passed` is a new run id on
 * the same head, two apps may publish one name, and a delayed delivery for an
 * older head carries a name that is live on the current one. A name-keyed map
 * loses the current head's result to a late delivery of a stale one.
 */
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

/**
 * One review as GitHub reported it, keyed in `reviews` by GitHub's own id for
 * that review.
 *
 * `dismissed` is a flag beside the state rather than a value of it: a dismissal
 * and the review it dismisses are two deliveries about one id, they arrive
 * unordered, and a dismissal written into `state` is undone by a redelivery of
 * the submission it followed.
 */
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

// cm:guard the unit is a PULL REQUEST and not an issue: all four events this is built from are about one, an issue carries several over its life (a merged predecessor beside an open replacement is the ordinary case), and an issue-keyed row would have to choose one of them and lose the rest. `issue_id` is nullable because a pull request whose branch names no issue is still a pull request this repository has, and dropping it would make the projection disagree with GitHub.
// cm:guard NOTHING here is a verdict. Every column is what an event said, or what a read made because an event said the answer moved; `devices/admissible.ts` is forbidden from filtering on any of them by its own cm:guard, which ISS-940 measured the cost of.
export const repoPullRequests = pgTable(
  'repo_pull_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // cm:guard the binding and not the provider: the binding carries which repository and which installation this row was built from, and a row outliving its binding would be a projection of a repository nothing can read any more.
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
    // cm:guard these four move together and describe ONE head, named by `refreshed_for_head`. A payload carrying a new head clears all five in the same statement that moves `head_sha`, because a behind-by count beside a head it was not computed for is a number that reads current and is not.
    behindBy: integer('behind_by'),
    aheadBy: integer('ahead_by'),
    mergeable: boolean('mergeable'),
    mergeableState: text('mergeable_state'),
    refreshedForHead: text('refreshed_for_head'),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
    // cm:guard the reason the last event-triggered read could not answer, stored rather than thrown: the payload-derived write has already committed by then, so throwing would answer the delivery 500 and have GitHub re-apply a payload to fix a read. This column is what makes the absence loud where a reader of the projection meets it.
    refreshError: text('refresh_error'),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergeCommitSha: text('merge_commit_sha'),
    checks: jsonb('checks').notNull().default({}).$type<ProjectedChecks>(),
    reviews: jsonb('reviews').notNull().default({}).$type<ProjectedReviews>(),
    // cm:guard the ordering evidence for the SCALARS above, and for nothing else. Webhook delivery is unordered and GitHub retries, so an older `synchronize` arriving after a newer one would otherwise rewind `head_sha` and make every check on the real head read as belonging to a head the row no longer names. Checks and reviews change independently of it and carry their own rules (`integrations/github/projection-shape.ts`).
    payloadUpdatedAt: timestamp('payload_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bindingNumberUq: uniqueIndex('repo_pull_requests_binding_number_uq').on(t.bindingId, t.number),
    issueIdx: index('repo_pull_requests_issue_idx').on(t.issueId),
    projectStateIdx: index('repo_pull_requests_project_state_idx').on(t.projectId, t.state),
    // cm:why a push to a base ref has to find every open pull request based on it, and that is the only query this projection makes that is not keyed on a binding and a number.
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
