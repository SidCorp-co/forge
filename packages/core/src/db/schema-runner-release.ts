/**
 * `runner_releases` — the one operation Forge owns to produce a runner release,
 * and what is true on the repository at every step of it.
 *
 * NOT a second notion of a release. The release is the GitHub Release the
 * `runner-v*` tag produces, and `install/fetch-release.ts` is still the only
 * thing that ingests one into the install channel. This row is the record of
 * the operation that produces it: which of the eight steps it reached, whether
 * the tag exists, what GitHub holds for that tag, and how it ended (ISS-1075).
 *
 * One row per tag, because a tag is immutable: a release that failed is not
 * retried under the same name, it is cut again under the next one. The single
 * exception is a SETTLED row whose `tag_state` is `unread` or `absent`, which
 * is a row no create request left this process for — that one re-arms in
 * place.
 *
 * Split out of `schema.ts` for the reason `schema-release-ledger.ts` states:
 * that file is frozen far over the file budget, so a new table cannot land
 * there without an amnesty.
 */

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

// cm:guard every value here is an OBSERVATION of the repository, never a summary of what Forge did. `unread` is nobody looked; `absent` is GitHub answered that the tag is not there AND no create request has left this process since; `unknown` is a create request went out and its answer never came; `present` is GitHub answered that the tag is there. Writing `absent` from a read that FAILED is the collapse this vocabulary exists to stop — it reads afterwards as a repository Forge inspected, and it is what the four-value set buys over the three-value one it replaced.
export const RUNNER_RELEASE_TAG_STATES = ['unread', 'absent', 'unknown', 'present'] as const;
export type RunnerReleaseTagState = (typeof RUNNER_RELEASE_TAG_STATES)[number];

// cm:guard this is a READING and never an inference from the build's conclusion: a build that failed may still have published a release, and one that succeeded may have published a draft the channel never ingests, because `install/fetch-release.ts` skips `draft` and `prerelease` outright. `unread` means nobody has looked; `unknown` means somebody looked and could not see.
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
// cm:guard the terminal pair and `settled_at` are ONE fact, so the database refuses a row that says it ended and carries no clock, and one that carries a clock while claiming to be in flight. `release_attempts` holds the other half of the same rule: a NULL `settled_at` there is a real state meaning "declared and never reported back", and it is a state only because nothing else on that row claims to be terminal.
const SETTLED_CHK = sql`(status IN ('published', 'failed')) = (settled_at IS NOT NULL)`;
// cm:guard `published` is the one status that asserts something about the world, so it may only be written over a tag that exists and a release that was READ and found whole — without this the status could say published over a `tag_state` of `unknown`, which is a release nobody can prove was cut.
const PUBLISHED_CHK = sql`status <> 'published' OR (tag_state = 'present' AND publication = 'published')`;
const ATTEMPT_CHK = sql`attempt >= 1`;

export const runnerReleases = pgTable(
  'runner_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // cm:guard the binding and not the provider, for `repo_pull_requests`' reason: the binding carries which repository and which installation the tag was cut through, and a delivery names its own binding, which is how an arriving build finds the release it belongs to.
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => integrationBindings.id, { onDelete: 'cascade' }),
    /** `owner/repo`, as the binding spelled it when the release was opened. */
    repository: text('repository').notNull(),
    /** The bare version, e.g. `0.13.3`. */
    version: text('version').notNull(),
    /** `runner-v` + the version. Unique per project, because a tag is immutable. */
    tag: text('tag').notNull(),
    // cm:guard the re-arm reuses the ROW, so without a number on it the attempt it replaced is indistinguishable from the one that replaced it: a caller still running inside the old attempt, or a sweep that selected the old one, writes into the new one over a `settled_at IS NULL` that is true again and a step and tag state that came back round to the same pair. Every conditional write on this table carries the attempt it was issued for and matches it, which is what makes that ABA lose in Postgres rather than in a branch.
    attempt: integer('attempt').notNull().default(1),
    /** The commit the tag points at. NULL until `resolve_commit` answered. */
    commitSha: text('commit_sha'),
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
    // cm:guard one line per step in the order they ran, whatever the outcome — the same shape `release_attempts.readings` holds and for the same reason: a record that keeps only what succeeded cannot answer how far a release got before it stopped.
    readings: jsonb('readings').notNull().default([]).$type<string[]>(),
    requestedById: uuid('requested_by_id').references(() => users.id, { onDelete: 'set null' }),
    // cm:guard written when the row is OPENED, before any request leaves this process, and it is what makes a release whose process died reachable at all. A deadline derived from the LAST WRITE would make a row nothing wrote to immortal, which is exactly the row worth finding.
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
    // cm:why the delivery arrives naming its binding and a tag, and that pair is the whole of the attribution — there is deliberately no lookup by commit (`integrations/github/runner-release-events.ts`).
    bindingTagIdx: index('runner_releases_binding_tag_idx').on(t.bindingId, t.tag),
    projectStatusIdx: index('runner_releases_project_status_idx').on(t.projectId, t.status),
    // cm:why the deadline pass selects every non-terminal row past its clock, so the index is on that clock under the partial predicate that names non-terminal.
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
