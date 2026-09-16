import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import {
  commentMentions,
  comments,
  issues,
  jobs,
  notifications,
  organizationMembers,
  projectMembers,
  projects,
  reconcileRuns,
} from '../db/schema.js';
import { agentChannelCondition } from '../issues/creator.js';
import { visibleProjectsWhere } from '../lib/authz.js';

/**
 * Bucket criteria for `GET /me/attention` (ISS-665 — keep this comment in sync
 * with the WHERE clauses below; it is the single place documenting why an item
 * is/isn't "needs attention"):
 *
 * - `needsReview`    — issues assigned to the caller sitting in a status that
 *   needs the caller's action (`developed` awaiting review, `reopen` awaiting
 *   a fix). Self-clearing: driven by live `issues.status`.
 * - `awaitingInput`  — issues assigned to the caller blocked on a human
 *   (`waiting`, `needs_info`) ON A PROJECT THE CALLER HOLDS A ROLE ON —
 *   ownership says the question is yours to answer, the project predicate says
 *   you may see the project it is asked about, and the bucket owes both
 *   (ISS-989). Self-clearing: live `issues.status`. `on_hold`
 *   is NOT here and adding it back is the defect ISS-970 fixed: it is a pause
 *   somebody CHOSE, not a question somebody is owed, and `cancel` parks with
 *   `parkIssue: true` by default (`pipeline/runs-control.ts`) so every
 *   duplicate run cancelled minted one row claiming a human was needed — 3
 *   cancels on 2026-09-07, 3 rows, 0 questions. The reasoning is `unseenDrafts`
 *   below, applied one bucket over: a list that always holds a few rows nobody
 *   must act on teaches its reader to skip the ones they must.
 * - `mentions`       — unread `@mention` notifications for the caller.
 *   Self-clearing: driven by `notifications.read`.
 * - `failedJobs`     — jobs the caller triggered that failed in the trailing
 *   7 days, EXCLUDING:
 *     1. superseded attempts — any job with a later retry (`jobs.retryOf`
 *        points back at it). `jobs/retry.ts` inserts every retry as a NEW row
 *        and leaves the original `status='failed'` forever, so without this
 *        exclusion a resolved-by-retry failure keeps reporting itself for up
 *        to 7 days. The LATEST attempt in a chain has no retry pointing at
 *        it, so it still surfaces if it is itself still failed.
 *     2. jobs whose linked issue has already reached a terminal state
 *        (`closed`, `awaiting_release`) — the problem was resolved by hand even
 *        though the job row itself stays `failed`. Jobs with no linked issue
 *        (PM/system/deploy jobs) are NOT excluded by this rule.
 * - `pendingSkillUpdates` — reconcile runs at the human decision gate for
 *   projects the caller admins (explicit `project_members` admin OR org
 *   owner/admin — mirrors `effectiveProjectRole`, ISS-807): `status='decided'
 *   AND gate='human'`, OR `status='escalated' AND verdict='escalate' AND
 *   acknowledged_at IS NULL`. Derived ENTIRELY from live `reconcile_runs`
 *   state — never from notification read status (invariant 10: a read/unread
 *   flag became a mute switch once already, the 75-draft incident).
 * - `unseenDrafts`   — `draft` issues an AGENT filed that no human has
 *   commented on yet, routed by {@link unseenDraftOwner} (ISS-881). `draft` is
 *   the inert proposal status: the dispatcher never touches it and no
 *   notification fires on a draft create, so before this bucket an agent-filed
 *   draft was reachable from no surface at all.
 *   Four deliberate narrowings, each of which the queue depends on:
 *     1. agent channel only (`created_via` set and not `web`) — a draft a
 *        person typed on the web has already been seen by that person, and
 *        nagging them about it is what teaches a queue to be ignored. Legacy
 *        `created_via IS NULL` rows read as human backlog, matching
 *        `issues/creator.ts`.
 *     2. no comment on a non-device credential (`author_device_id IS NULL`) —
 *        one such comment is the receipt. It is weaker than it reads: identity
 *        follows the token, so an agent holding a person's PAT clears the
 *        bucket as that person (measured 2026-09-04: 3,172 of 23,414 comments
 *        are agent writes on a human credential). It is also an APPROXIMATION
 *        of the durable seen-receipt ISS-791 owns, not that receipt: it cannot
 *        tell "never read" from "read and parked without replying". Both gaps
 *        close the same way — by giving agents their own identity, not by
 *        storing a self-declared flag per comment.
 *     3. assignment wins, and only an UNOWNED draft falls back to the creator
 *        or to whoever administers the project — see
 *        {@link unseenDraftOwner} for why the creator alone reaches nobody.
 *     4. ordered by priority then recency and capped at
 *        {@link UNSEEN_DRAFTS_CAP}, while `unseenDraftsTotal` reports the
 *        UNCLIPPED count — so a backlog is bounded on screen, ordered by what
 *        matters, and never hidden. Measured on forge-beta 2026-08-30 for the
 *        real owner: 428 qualifying drafts over 16 projects, of which 22 are
 *        forge-dev's. This bucket is CALLER-scoped, not project-scoped; any
 *        single project's figure understates what one person sees.
 *   Self-clearing both ways: leaving `draft`, or a human comment, drops the
 *   row with no bookkeeping. Nothing here writes state.
 */
export const NEEDS_REVIEW_STATUSES = ['developed', 'reopen'] as const;
export const AWAITING_INPUT_STATUSES = ['waiting', 'needs_info'] as const;
const FAILED_JOB_RESOLVED_ISSUE_STATUSES = ['closed', 'awaiting_release'] as const;
const PER_BUCKET = 5;
const PENDING_SKILL_UPDATES_CAP = 20;

export const UNSEEN_DRAFTS_CAP = 20;

export const AWAITING_INPUT_CAP = 20;

const retryJobs = alias(jobs, 'retry_jobs');

export interface AttentionIssueRow {
  id: string;
  issSeq: number;
  issuePrefix: string | null;
  title: string;
  status: string;
  updatedAt: Date;
  projectSlug: string;
  projectName: string;
}

/** The awaiting-input row, which carries WHY it is ranked where it is. */
export interface AttentionAwaitingRow extends AttentionIssueRow {
  claimsHeld: number;
  workspacesPinned: number;
  dependents: number;
  blockerKind: string | null;
  questionId: string | null;
}

export interface AttentionMentionRow {
  notificationTitle: string | null;
  mentionedAt: Date;
  issueDocId: string;
  issSeq: number;
  issuePrefix: string | null;
  projectSlug: string;
  projectName: string;
}

export interface AttentionFailedJobRow {
  type: string;
  finishedAt: Date | null;
  createdAt: Date;
  error: string | null;
  issueDocId: string | null;
  issSeq: number | null;
  issuePrefix: string | null;
  projectSlug: string;
  projectName: string;
}

export interface AttentionReconcileRow {
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  projectSlug: string;
  projectName: string;
}

export function ownedForAnswer(userId: string) {
  return or(
    eq(issues.assigneeId, userId),
    and(isNull(issues.assigneeId), eq(issues.createdById, userId)),
  );
}

const issueFields = {
  id: issues.id,
  issSeq: issues.issSeq,
  issuePrefix: projects.issuePrefix,
  title: issues.title,
  status: issues.status,
  updatedAt: issues.updatedAt,
  projectSlug: projects.slug,
  projectName: projects.name,
} as const;

export function selectNeedsReview(userId: string): Promise<AttentionIssueRow[]> {
  return db
    .select(issueFields)
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(eq(issues.assigneeId, userId), inArray(issues.status, [...NEEDS_REVIEW_STATUSES])))
    .orderBy(desc(issues.updatedAt))
    .limit(PER_BUCKET) as Promise<AttentionIssueRow[]>;
}

function openQuestionCost(column: string): SQL<number> {
  return sql<number>`coalesce((select sum(q.${sql.raw(column)}) from agent_questions q
    where q.issue_id = issues.id and q.project_id = issues.project_id
      and q.status = 'open'), 0)::int`;
}

const AWAITING_COST_ORDER = [
  desc(openQuestionCost('claims_held')),
  desc(openQuestionCost('workspaces_pinned')),
  desc(openQuestionCost('dependents')),
  issues.updatedAt,
] as const;

export function selectAwaitingInput(userId: string): Promise<AttentionAwaitingRow[]> {
  return db
    .select({
      ...issueFields,
      claimsHeld: openQuestionCost('claims_held'),
      workspacesPinned: openQuestionCost('workspaces_pinned'),
      dependents: openQuestionCost('dependents'),
      blockerKind: openQuestionColumn('blocker_kind'),
      questionId: openQuestionColumn('id'),
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
    )
    .where(
      and(
        ownedForAnswer(userId),
        inArray(issues.status, [...AWAITING_INPUT_STATUSES]),
        ...visibleProjectsWhere(),
      ),
    )
    .orderBy(...AWAITING_COST_ORDER)
    .limit(AWAITING_INPUT_CAP) as Promise<AttentionAwaitingRow[]>;
}

function openQuestionColumn(column: string): SQL<string | null> {
  return sql<string | null>`(select q.${sql.raw(column)} from agent_questions q
    where q.issue_id = issues.id and q.project_id = issues.project_id
      and q.status = 'open'
    order by q.created_at desc, q.id desc limit 1)`;
}

function adminsProject(userId: string) {
  return or(
    exists(
      db
        .select({ one: sql`1` })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projects.id),
            eq(projectMembers.userId, userId),
            eq(projectMembers.role, 'admin'),
          ),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, projects.orgId),
            eq(organizationMembers.userId, userId),
            inArray(organizationMembers.role, ['owner', 'admin']),
          ),
        ),
    ),
  );
}

function unseenDraftOwner(userId: string): SQL {
  return or(
    eq(issues.assigneeId, userId),
    and(isNull(issues.assigneeId), or(eq(issues.createdById, userId), adminsProject(userId))),
  ) as SQL;
}

function unseenDraftCondition(userId: string): SQL {
  return and(
    eq(issues.status, 'draft'),
    agentChannelCondition(),
    unseenDraftOwner(userId),
    notExists(
      db
        .select({ one: sql`1` })
        .from(comments)
        .where(and(eq(comments.issueId, issues.id), isNull(comments.authorDeviceId))),
    ),
  ) as SQL;
}

const PRIORITY_RANK = sql`case ${issues.priority} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;

export function selectUnseenDrafts(userId: string): Promise<AttentionIssueRow[]> {
  return db
    .select(issueFields)
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(unseenDraftCondition(userId))
    .orderBy(PRIORITY_RANK, desc(issues.updatedAt))
    .limit(UNSEEN_DRAFTS_CAP) as Promise<AttentionIssueRow[]>;
}

export function selectUnseenDraftCount(userId: string): Promise<{ total: number | null }[]> {
  return db
    .select({ total: sql<number>`count(*)::int` })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(unseenDraftCondition(userId)) as Promise<{ total: number | null }[]>;
}

export function selectMentions(userId: string): Promise<AttentionMentionRow[]> {
  return db
    .select({
      notificationTitle: notifications.title,
      mentionedAt: commentMentions.createdAt,
      issueDocId: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      projectSlug: projects.slug,
      projectName: projects.name,
    })
    .from(commentMentions)
    .innerJoin(comments, eq(comments.id, commentMentions.commentId))
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .leftJoin(
      notifications,
      and(
        eq(notifications.userId, commentMentions.userId),
        eq(notifications.type, 'mention'),
        eq(notifications.issueId, comments.issueId),
      ),
    )
    .where(
      and(
        eq(commentMentions.userId, userId),
        sql`(${notifications.read} IS NULL OR ${notifications.read} = false)`,
      ),
    )
    .orderBy(desc(commentMentions.createdAt))
    .limit(PER_BUCKET) as Promise<AttentionMentionRow[]>;
}

export function selectFailedJobs(userId: string): Promise<AttentionFailedJobRow[]> {
  return db
    .select({
      type: jobs.type,
      finishedAt: jobs.finishedAt,
      createdAt: jobs.createdAt,
      error: jobs.error,
      issueDocId: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      projectSlug: projects.slug,
      projectName: projects.name,
    })
    .from(jobs)
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .leftJoin(issues, eq(issues.id, jobs.issueId))
    .where(
      and(
        eq(jobs.createdBy, userId),
        eq(jobs.status, 'failed'),
        sql`${jobs.createdAt} >= now() - interval '7 days'`,
        notExists(db.select({ one: sql`1` }).from(retryJobs).where(eq(retryJobs.retryOf, jobs.id))),
        or(isNull(issues.id), notInArray(issues.status, [...FAILED_JOB_RESOLVED_ISSUE_STATUSES])),
      ),
    )
    .orderBy(desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`))
    .limit(PER_BUCKET) as Promise<AttentionFailedJobRow[]>;
}

export function selectPendingSkillUpdates(userId: string): Promise<AttentionReconcileRow[]> {
  return db
    .select({
      status: reconcileRuns.status,
      createdAt: reconcileRuns.createdAt,
      decidedAt: reconcileRuns.decidedAt,
      projectSlug: projects.slug,
      projectName: projects.name,
    })
    .from(reconcileRuns)
    .innerJoin(projects, eq(projects.id, reconcileRuns.projectId))
    .where(
      and(
        adminsProject(userId),
        or(
          and(eq(reconcileRuns.status, 'decided'), eq(reconcileRuns.gate, 'human')),
          and(
            eq(reconcileRuns.status, 'escalated'),
            eq(reconcileRuns.verdict, 'escalate'),
            isNull(reconcileRuns.acknowledgedAt),
          ),
        ),
      ),
    )
    .orderBy(desc(sql`coalesce(${reconcileRuns.decidedAt}, ${reconcileRuns.createdAt})`))
    .limit(PENDING_SKILL_UPDATES_CAP) as Promise<AttentionReconcileRow[]>;
}
