/**
 * An issue's review (REQ-36 BC-8, BC-13; Issue to release r20 `rule-merge`): the store, the write,
 * and the question the merge mark asks. The review is the diff `base..head` checked against the
 * checklist of each pattern the issue's design chose and against the evidence recorded at `head`,
 * one result per checklist line and per code-property criterion. It reruns nothing. It is recorded
 * by core as a `review` record, with each code-property criterion's result written as the review's
 * verdict on it at `head`, in one transaction. The rules are `review-rules.ts`.
 *
 * A reviewer is never the building run: the run sessions that hold the issue or recorded its checks,
 * and an account that recorded a check with no session. The mark of an issue whose project declares
 * the merge check (`validation.mergeCheck: required`) is refused MERGE_REVIEW_MISSING until a
 * passing review by another stands at the commit it marks; a merge the source host's webhook
 * records is not asked, as the merge check is not.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import type {
  IssueReview,
  IssueReviewRefusalCode,
  RecordReviewRequest,
  ReviewView,
} from '@forge/contracts/issue-review';
import { PATTERN_CATALOG } from '@forge/contracts/pattern-catalog';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { issues } from '../db/schema.js';
import { issueCheckRuns } from '../db/schema-issue-check-runs.js';
import { criterionVerdicts } from '../db/schema-issue-criteria.js';
import { liveIssueLeasesSql } from '../db/schema-issue-leases.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';
import type { Actor } from './activity.js';
import { recordVerdict } from './criteria/verdict-record.js';
import { issueDesignOf } from './design-record.js';
import { issueDisplayIds } from './display-ids.js';
import { passingHeads } from './merge-check-rules.js';
import { liveOnBox, runOfCall } from './pattern-runs.js';
import { catalogOf } from './patterns.js';
import { readProjectDocument } from './ports.js';
import { listRecordEvents, type RecordEvent, writeCoreRecord } from './record-events/store.js';
import {
  type Builders,
  type HeadEvidence,
  outcomeOf,
  owedOf,
  type Reviewer,
  type ReviewRefusal,
  reviewerRefusal,
  reviewRecordFields,
  reviewRefusals,
  type StoredReview,
  storedReviewOf,
  unreviewedDetail,
} from './review-rules.js';

const refused = (refusals: ReviewRefusal[]) => new RefusalError(refusals, 'REVIEW_REFUSED');

const one = (code: IssueReviewRefusalCode, detail: string, path = ''): RefusalError =>
  refused([{ code, path, detail }]);

async function issueRefOf(issueId: string): Promise<string> {
  return (await issueDisplayIds([issueId])).get(issueId) ?? issueId;
}

/**
 * Who built the issue's change: the sessions holding its lease now and those that recorded a check on
 * it, the accounts that recorded one with no session, and whether one of those sessions is live on
 * `box`.
 */
async function buildersOf(issueId: string, box: string | null): Promise<Builders> {
  const [issue] = await db
    .select({ projectId: issues.projectId, seq: issues.issSeq })
    .from(issues)
    .where(eq(issues.id, issueId));
  const leases = issue
    ? rowsOf<{ session_id: string }>(
        await db.execute(sql`
          SELECT l.session_id FROM ${liveIssueLeasesSql()} l
           WHERE l.project_id = ${issue.projectId}
             AND l.issue_key = ${canonicalIssueKey(Number(issue.seq))}
        `),
      )
    : [];
  const checks = await db
    .select({ session: issueCheckRuns.runSessionId, actor: issueCheckRuns.recordedBy })
    .from(issueCheckRuns)
    .where(eq(issueCheckRuns.issueId, issueId));
  const sessions = new Set<string>([
    ...leases.map((l) => l.session_id),
    ...checks.flatMap((c) => (c.session ? [c.session] : [])),
  ]);
  const actors = new Set(checks.flatMap((c) => (c.session === null && c.actor ? [c.actor] : [])));
  let live = false;
  if (box !== null) {
    for (const session of sessions) {
      if (await liveOnBox(session, box)) {
        live = true;
        break;
      }
    }
  }
  return { sessions, actors, liveOnBox: live };
}

/** What core holds at `head`: its checks, whether a merge check passed there, and its verdicts. */
async function evidenceAt(issueId: string, head: string): Promise<HeadEvidence> {
  const checks = await db
    .select({ kind: issueCheckRuns.kind, result: issueCheckRuns.result })
    .from(issueCheckRuns)
    .where(and(eq(issueCheckRuns.issueId, issueId), eq(issueCheckRuns.headSha, head)));
  const verifications = await listRecordEvents(issueId, {
    kinds: ['verification'],
    kernelOnly: true,
  });
  const verdicts = await db
    .select({ id: criterionVerdicts.id })
    .from(criterionVerdicts)
    .where(
      and(
        eq(criterionVerdicts.issueId, issueId),
        sql`lower(${criterionVerdicts.commitSha}) = ${head}`,
      ),
    );
  return {
    checks,
    mergeCheckPassed: passingHeads(verifications).includes(head),
    verdicts: verdicts.length,
  };
}

/** What a review of this issue owes, or the refusal naming why none can be recorded yet. */
async function owedFor(issue: { id: string; projectId: string }) {
  const design = await issueDesignOf(issue);
  if (!design.design || !design.check.passed) {
    const ref = await issueRefOf(issue.id);
    const why = design.check.passed ? 'no design is recorded' : design.check.detail;
    return {
      ok: false as const,
      code: 'REVIEW_DESIGN_MISSING' as const,
      detail: `${ref}'s design does not pass its check (${why}), so the patterns and code-property criteria a review owes are not known. Record it with PUT /api/issues/:id/design`,
    };
  }
  const owed = owedOf({
    design: design.design,
    catalog: await catalogOf(issue.projectId),
    entries: PATTERN_CATALOG,
  });
  return { ok: true as const, owed };
}

/** Whether the merge mark asks this project's issues for a review. */
async function reviewRequired(projectId: string): Promise<boolean> {
  const document = (await readProjectDocument(projectId))?.document;
  return document?.validation?.mergeCheck === 'required';
}

/** The reviews recorded on the issue. */
export async function recordedReviewsOf(issueId: string): Promise<StoredReview[]> {
  const records = await listRecordEvents(issueId, { kinds: ['review'], kernelOnly: true });
  return records.flatMap((r: RecordEvent) => {
    const stored = storedReviewOf(r);
    return stored ? [stored] : [];
  });
}

/**
 * Record a review on the issue — its record and each code-property criterion's verdict, in one
 * transaction — or refuse it by the name of what is wrong, writing nothing.
 */
export async function recordReview(args: {
  issue: { id: string; projectId: string; status: string };
  body: RecordReviewRequest;
  actor: Actor;
  author: { userId: string; agency: ActorAgency };
  /** The device a box credential belongs to; null for a person's. */
  box: string | null;
}): Promise<{ review: ReviewView; record: RecordEvent }> {
  const { issue, body } = args;
  const ref = await issueRefOf(issue.id);
  if ((ISSUE_TERMINAL_STATUSES as readonly string[]).includes(issue.status)) {
    throw one(
      'REVIEW_ISSUE_FINISHED',
      `${ref} is ${issue.status}; a finished issue takes no review`,
    );
  }
  const owed = await owedFor(issue);
  if (!owed.ok) throw one(owed.code, owed.detail);
  const faults = reviewRefusals(body, owed.owed);
  if (faults.length) throw refused(faults);
  const run = await runOfCall({
    projectId: issue.projectId,
    issueId: issue.id,
    box: args.box,
    run: body.run,
  });
  if (!run.ok) {
    throw refused(run.refusals.map((r) => ({ ...r, code: 'REVIEW_RUN_UNKNOWN' as const })));
  }
  const reviewer: Reviewer = { ...run.value, actor: args.actor.id };
  const builders = await buildersOf(issue.id, args.box);
  const who = reviewerRefusal(ref, reviewer, builders);
  if (who) throw refused([who]);
  const head = body.head.toLowerCase();
  const fields = reviewRecordFields({
    body,
    owed: owed.owed,
    reviewer,
    builders,
    evidence: await evidenceAt(issue.id, head),
  });
  const record = await db.transaction(async (tx) => {
    const written = await writeCoreRecord(tx, {
      issueId: issue.id,
      actor: args.actor,
      kind: 'review',
      fields,
    });
    for (const r of body.criteria) {
      await recordVerdict(tx, {
        issue,
        draft: {
          criterion: r.criterion,
          verdict: r.result,
          reason: r.reason,
          identity: { kind: 'commit', sha: head },
          evidence: r.evidence,
          judge: 'review',
        },
        author: { userId: args.author.userId, deviceId: args.box, agency: args.author.agency },
      });
    }
    return written;
  });
  const { result, failed } = outcomeOf(body);
  return {
    review: {
      id: record.id,
      base: body.base.toLowerCase(),
      head,
      result,
      failed,
      reviewer: { session: reviewer.session, box: reviewer.box, user: reviewer.actor },
      recordedAt: record.createdAt.toISOString(),
    },
    record,
  };
}

/** `GET /api/issues/:id/review`: what a review owes, whether the mark asks one, and those recorded. */
export async function issueReviewOf(issue: {
  id: string;
  projectId: string;
}): Promise<IssueReview> {
  const [ref, owed, required, reviews] = await Promise.all([
    issueRefOf(issue.id),
    owedFor(issue),
    reviewRequired(issue.projectId),
    recordedReviewsOf(issue.id),
  ]);
  return {
    issue: ref,
    required,
    owed: owed.ok ? owed.owed : null,
    refusal: owed.ok ? null : { code: owed.code, detail: owed.detail },
    reviews: reviews.map((r) => ({
      id: r.id,
      base: r.base,
      head: r.head,
      result: r.result,
      failed: r.failed,
      reviewer: { session: r.reviewer.session, box: r.reviewer.box, user: r.reviewer.actor },
      recordedAt: r.recordedAt.toISOString(),
    })),
  };
}

/**
 * The merge mark's refusal where a review is owed and no passing one by another than the building
 * run stands at `commit`, or null. Who built it is read now, so a reviewer that recorded a check
 * since its review counts as a builder.
 */
export async function unreviewedMergeRefusal(args: {
  issueId: string;
  projectId: string;
  commit: string | null;
}): Promise<string | null> {
  if (!(await reviewRequired(args.projectId))) return null;
  const [issueRef, reviews, builders] = await Promise.all([
    issueRefOf(args.issueId),
    recordedReviewsOf(args.issueId),
    buildersOf(args.issueId, null),
  ]);
  return unreviewedDetail({ issueRef, commit: args.commit, reviews, builders });
}
