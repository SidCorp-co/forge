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

/**
 * Bucket criteria for `GET /me/attention` (ISS-665 — keep this comment in sync
 * with the WHERE clauses below; it is the single place documenting why an item
 * is/isn't "needs attention"):
 *
 * - `needsReview`    — issues assigned to the caller sitting in a status that
 *   needs the caller's action (`developed` awaiting review, `reopen` awaiting
 *   a fix). Self-clearing: driven by live `issues.status`.
 * - `awaitingInput`  — issues assigned to the caller blocked on a human
 *   (`waiting`, `needs_info`, `on_hold`). Self-clearing: live `issues.status`.
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
 *        (`closed`, `released`) — the problem was resolved by hand even
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
 *     2. no human comment (`is_ai = false AND author_device_id IS NULL`, the
 *        durable human test guarded on `comments`) — one human comment is the
 *        receipt, and an agent cannot forge it. This is an APPROXIMATION of
 *        the durable seen-receipt ISS-791 owns, not that receipt: it cannot
 *        tell "never read" from "read and parked without replying".
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
export const AWAITING_INPUT_STATUSES = ['waiting', 'needs_info', 'on_hold'] as const;
const FAILED_JOB_RESOLVED_ISSUE_STATUSES = ['closed', 'released'] as const;
const PER_BUCKET = 5;
const PENDING_SKILL_UPDATES_CAP = 20;

// cm:why 20, not PER_BUCKET: the cap must still return the draft this bucket was built to surface. Measured on forge-beta 2026-08-30 against the CALLER's full cross-project set (428 drafts, 16 projects — not the 22 in forge-dev alone), ISS-871 ranks 17th under this bucket's priority-then-recency order, so every cap at or below 16 renders the bucket unable to show its own reason for existing. Under plain recency it ranked 28th, which is why the order is not `desc(updatedAt)` like its neighbours.
export const UNSEEN_DRAFTS_CAP = 20;

// cm:why drizzle cannot reference one table twice in a statement, and the retry-chain exclusion compares a job against its own retry row.
const retryJobs = alias(jobs, 'retry_jobs');

export interface AttentionIssueRow {
  id: string;
  issSeq: number;
  title: string;
  status: string;
  updatedAt: Date;
  projectSlug: string;
  projectName: string;
}

export interface AttentionMentionRow {
  notificationTitle: string | null;
  mentionedAt: Date;
  issueDocId: string;
  issSeq: number;
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

// cm:edge contract -> packages/core/src/notifications/notify-transitions.ts — a park notifies `assigneeId ?? createdById`, so the bucket that carries the same park must resolve ownership the same way. Notifying the creator and then bucketing by assignee is how a question reaches a human's inbox and no list they can act on: an agent-filed issue has no assignee, and MCP `forge_issues` cannot set one.
// cm:why `needsReview` deliberately keeps assignee-only. A question parked on an issue you filed is addressed to you; a `developed` issue with no assignee is not yours to review merely because you opened it.
export function ownedForAnswer(userId: string) {
  return or(
    eq(issues.assigneeId, userId),
    and(isNull(issues.assigneeId), eq(issues.createdById, userId)),
  );
}

const issueFields = {
  id: issues.id,
  issSeq: issues.issSeq,
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

export function selectAwaitingInput(userId: string): Promise<AttentionIssueRow[]> {
  return db
    .select(issueFields)
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(ownedForAnswer(userId), inArray(issues.status, [...AWAITING_INPUT_STATUSES])))
    .orderBy(desc(issues.updatedAt))
    .limit(PER_BUCKET) as Promise<AttentionIssueRow[]>;
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

// cm:guard assignment still wins: an assigned draft reaches ONLY its assignee. The creator-or-admin fallback applies while nobody owns it, so widening it past `assigneeId IS NULL` puts one proposal in two lists and each reader assumes the other triaged it.
// cm:why the creator alone reaches NOBODY on a real deployment, which is the defect this rule exists to fix rather than a refinement of it. MCP `forge_issues create` stamps `createdById: device.ownerId` — the account that paired the runner — while the person who opens the UI signs in as a different org admin. Measured on forge-beta 2026-08-30: creator-only returned 428 drafts to the paired account nobody signs into and exactly 0 to the org admin who does, so `draft` had a bucket and still reached no human. Project admin is the same resolver `pendingSkillUpdates` already uses for a triage gate.
function unseenDraftOwner(userId: string): SQL {
  return or(
    eq(issues.assigneeId, userId),
    and(isNull(issues.assigneeId), or(eq(issues.createdById, userId), adminsProject(userId))),
  ) as SQL;
}

// cm:guard both reads of this bucket MUST go through this one predicate, and both MUST join `projects` — `adminsProject` resolves against `projects.id`/`projects.orgId`. A list built from a wider rule than the count (or the reverse) shows 20 rows under a total of 3, and the surface would then be lying in the same breath it was added to stop a surface from lying.
function unseenDraftCondition(userId: string): SQL {
  return and(
    eq(issues.status, 'draft'),
    agentChannelCondition(),
    unseenDraftOwner(userId),
    notExists(
      db
        .select({ one: sql`1` })
        .from(comments)
        .where(
          and(
            eq(comments.issueId, issues.id),
            eq(comments.isAi, false),
            isNull(comments.authorDeviceId),
          ),
        ),
    ),
  ) as SQL;
}

// cm:why priority before recency, unlike every neighbouring bucket: those are capped at 5 over a caller's own handful, this one sits in front of a 428-deep cross-project backlog where pure recency means one busy project owns all 20 rows and a `high` proposal from last week is never seen.
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

// cm:guard every function here returns the drizzle query UNAWAITED. Awaiting inside one makes it subscribe the moment it is called rather than when `Promise.all` subscribes, which reorders the reads against each other — and the unit lane's mock chain resolves POSITIONALLY, so an early subscriber silently serves itself another bucket's rows.
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
        // cm:why the NULL branch is deliberate, not a missing join: a mention predating the notify-mentions subscriber has no notification row at all, and dropping it would silence the oldest mentions forever.
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
        // cm:why every retry is inserted as a NEW row and the original stays `failed` forever, so without this a failure a retry already resolved keeps reporting itself for 7 days.
        notExists(db.select({ one: sql`1` }).from(retryJobs).where(eq(retryJobs.retryOf, jobs.id))),
        // cm:why a job whose issue reached closed/released was resolved by hand even though the row stays `failed`; a null-issue job (PM/system/deploy) carries no such signal, which is why the isNull branch KEEPS it.
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
