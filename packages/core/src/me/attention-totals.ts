/**
 * The attention read's whole counts, from the same predicates its buckets' rows come from, before
 * any cap: the one number a screen says for a set, whatever part of it the list holds (ISS-1229 r14).
 */

import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  issues,
  jobs,
  organizationMembers,
  projectMembers,
  projects,
  reconcileRuns,
} from '../db/schema.js';
import { visibleProjectsWhere } from '../lib/authz.js';
import { BLOCKED_STATUSES } from '../projects/health-aggregates.js';
import {
  type AttentionBucket,
  type AttentionScope,
  awaitingInputWhere,
  failedJobIssueWhere,
  failedJobOwnWhere,
  failedJobsWhere,
  inScope,
  isNot,
  memberOf,
  mentionsOf,
  needsReviewWhere,
  orgMemberOf,
  owedAnswerWhere,
  pendingSkillUpdateWhere,
  unseenDraftCondition,
} from './attention-buckets.js';

const count = sql<number>`count(*)::int`;

/** Each bucket counted whole. */
export async function selectBucketTotals(
  userId: string,
  scope: AttentionScope = {},
): Promise<Record<AttentionBucket, number>> {
  const n = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  const [needsReview, awaitingInput, mentions, failedJobs, pendingSkillUpdates, unseenDrafts] =
    await Promise.all([
      db
        .select({ n: count })
        .from(issues)
        .innerJoin(projects, eq(projects.id, issues.projectId))
        .where(and(needsReviewWhere(userId), inScope(scope))),
      db
        .select({ n: count })
        .from(issues)
        .innerJoin(projects, eq(projects.id, issues.projectId))
        .leftJoin(projectMembers, memberOf(userId))
        .leftJoin(organizationMembers, orgMemberOf(userId))
        .where(and(awaitingInputWhere(userId), inScope(scope))),
      mentionsOf({ n: count }, userId, scope) as unknown as Promise<{ n: number }[]>,
      db
        .select({ n: count })
        .from(jobs)
        .innerJoin(projects, eq(projects.id, jobs.projectId))
        .leftJoin(issues, eq(issues.id, jobs.issueId))
        .where(and(failedJobsWhere(userId), inScope(scope))),
      db
        .select({ n: count })
        .from(reconcileRuns)
        .innerJoin(projects, eq(projects.id, reconcileRuns.projectId))
        .where(pendingSkillUpdateWhere(userId, scope)),
      db
        .select({ n: count })
        .from(issues)
        .innerJoin(projects, eq(projects.id, issues.projectId))
        .where(and(unseenDraftCondition(userId), inScope(scope))),
    ]);
  return {
    needsReview: n(needsReview),
    awaitingInput: n(awaitingInput),
    mentions: n(mentions),
    failedJobs: n(failedJobs),
    pendingSkillUpdates: n(pendingSkillUpdates),
    unseenDrafts: n(unseenDrafts),
  };
}

/** What a project holds in the buckets its Needs you list is made of, counted whole. */
export interface AttentionProjectTotals {
  needsReview: number;
  awaitingInput: number;
  failedJobs: number;
  /**
   * Issues of the project parked at a status the health row's parked list (`blockers`) holds, that no
   * bucket above lists: other people's parks, mostly. Needs you lists them beside the buckets and
   * once each, so the four add up to its whole count with no issue counted twice (ISS-1229 r14).
   */
  parkedOnly: number;
}

/** The same, by project slug; a project with nothing in any of them has no entry. */
export async function selectAttentionTotals(
  userId: string,
  scope: AttentionScope = {},
): Promise<Record<string, AttentionProjectTotals>> {
  const [review, awaiting, failed, parked] = await Promise.all([
    db
      .select({ slug: projects.slug, n: count })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(and(needsReviewWhere(userId), inScope(scope)))
      .groupBy(projects.slug),
    db
      .select({ slug: projects.slug, n: count })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .leftJoin(projectMembers, memberOf(userId))
      .leftJoin(organizationMembers, orgMemberOf(userId))
      .where(and(awaitingInputWhere(userId), inScope(scope)))
      .groupBy(projects.slug),
    db
      .select({ slug: projects.slug, n: count })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .leftJoin(issues, eq(issues.id, jobs.issueId))
      .where(and(failedJobsWhere(userId), inScope(scope)))
      .groupBy(projects.slug),
    db
      .select({ slug: projects.slug, n: count })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .leftJoin(projectMembers, memberOf(userId))
      .leftJoin(organizationMembers, orgMemberOf(userId))
      .where(
        and(
          inArray(issues.status, [...BLOCKED_STATUSES]),
          ...visibleProjectsWhere(),
          inScope(scope),
          isNot(owedAnswerWhere(userId)),
          isNot(needsReviewWhere(userId)),
          // Needs you lists a parked issue once: where a failed job of the reader's names it, as that.
          notExists(
            db
              .select({ one: sql`1` })
              .from(jobs)
              .where(
                and(eq(jobs.issueId, issues.id), failedJobOwnWhere(userId), failedJobIssueWhere()),
              ),
          ),
        ),
      )
      .groupBy(projects.slug),
  ]);
  const totals: Record<string, AttentionProjectTotals> = {};
  const at = (slug: string) => {
    totals[slug] ??= { needsReview: 0, awaitingInput: 0, failedJobs: 0, parkedOnly: 0 };
    return totals[slug];
  };
  for (const r of review) at(r.slug).needsReview = r.n;
  for (const r of awaiting) at(r.slug).awaitingInput = r.n;
  for (const r of failed) at(r.slug).failedJobs = r.n;
  for (const r of parked) at(r.slug).parkedOnly = r.n;
  return totals;
}
