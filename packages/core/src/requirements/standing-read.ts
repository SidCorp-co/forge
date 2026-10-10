/**
 * Gathers the facts `standing.ts` derives from, for a page of requirements at once; the history a
 * requirement's page reads is `history-read.ts`.
 */

import { type IssueStatus, PARK_STATUSES } from '@forge/contracts/issue-machine';
import { issueStatusToneOn } from '@forge/contracts/issue-vocabulary';
import type { Approvals } from '@forge/contracts/person-gates';
import { releaseApprovalRequired } from '@forge/contracts/releases';
import type {
  BcVerdict,
  RequirementStanding,
  RequirementState,
} from '@forge/contracts/requirements';
import { changedSincePlan } from '@forge/contracts/requirements';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  type RequirementStatus,
  type RevisionState,
  requirementBaselines,
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { runners } from '../db/schema-runners.js';
import { suggestions } from '../db/schema-suggestions.js';
import { activeIssuePrefix, issueWaitsOf } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { readEffectivePolicy, readProjectDocument } from '../project-config/index.js';
import { followReadsOf } from './auto-follow.js';
import { linkedContractsOf } from './baselines.js';
import { requirementDependents } from './dependents.js';
import { feedbackCountsOf, feedbackLinksOf } from './feedback-links.js';
import { changedTracedOf } from './plan-drift.js';
import { staleContractPinsOf, stalePinsOf } from './rules.js';
import { mergeOrDropOf } from './stale-drafts.js';
import { deriveStanding } from './standing.js';
import {
  issueCriteriaOf,
  issueTimesOf,
  latestContractPinsOf,
  latestPinsOf,
  liveBuildOf,
  statusSinceOf,
  unapprovedDesignsOf,
} from './standing-facts.js';
import { awaitsReleaseOnly } from './standing-work.js';

interface StandingRow {
  id: string;
  projectId: string;
  status: string;
  currentRevision: number | null;
  ownerId: string | null;
  updatedAt: Date;
}

interface StandingViewer {
  userId: string;
  canSignOff: boolean;
  canAdmit: boolean;
  canApproveBreakdown?: boolean;
}

/** Rows a caller already holds for these requirements (the detail does), so they are not read twice. */
export interface StandingPreload {
  revisions: readonly (typeof requirementRevisions.$inferSelect)[];
  criteria: readonly (typeof requirementCriteria.$inferSelect)[];
  linked: readonly Pick<
    typeof issues.$inferSelect,
    | 'requirementId'
    | 'id'
    | 'issSeq'
    | 'title'
    | 'status'
    | 'updatedAt'
    | 'plan'
    | 'plannedRevision'
  >[];
  baselines: readonly (typeof requirementBaselines.$inferSelect)[];
  prefix: string | null;
  gates: DocumentGates;
}

/** What the project document asks of a person: a release approval, and each step's switch (REQ-34 BC-25). */
export interface DocumentGates {
  releaseApproval: boolean;
  approvals: Approvals | null;
}

const firstBaselineAt = (
  rows: readonly { requirementId: string; revision: number; agreedAt: Date }[],
  id: string,
  revision: number | null,
) =>
  rows.reduce<Date | null>(
    (m, b) =>
      b.requirementId === id && b.revision === revision && (!m || b.agreedAt < m) ? b.agreedAt : m,
    null,
  );

/** A requirement's owner as its standing names them; null where it has none. */
function ownerOf(
  id: string | null,
  people: ReadonlyMap<string, { name: string | null; kind: 'human' | 'agent' }>,
): RequirementStanding['owner'] {
  if (!id) return null;
  return { id, name: people.get(id)?.name ?? null, kind: people.get(id)?.kind ?? 'human' };
}

/** `projectId`'s person gates, from one read of its document: whether a release needs approval, by
 *  the one predicate release reads too, and which steps ask a person. */
export async function documentGatesIn(projectId: string): Promise<DocumentGates> {
  const document = (await readProjectDocument(projectId))?.document;
  return {
    releaseApproval: releaseApprovalRequired(document),
    approvals: document?.approvals ?? null,
  };
}

const uncoveredList = z.object({
  uncovered: z.array(z.object({ code: z.string(), reason: z.string() })).optional(),
});

/**
 * Per requirement, per BC code, the reason the newest accepted breakdown naming the code gave for
 * leaving it without an issue. An accepted suggestion keeps its payload (`suggestions_payload_chk`),
 * so the accept is the record and no column copies it.
 */
async function uncoveredOf(ids: readonly string[]): Promise<Map<string, Map<string, string>>> {
  const rows = await db
    .select({ requirementId: suggestions.requirementId, payload: suggestions.payload })
    .from(suggestions)
    .where(
      and(
        inArray(suggestions.requirementId, [...ids]),
        eq(suggestions.kind, 'breakdown'),
        eq(suggestions.status, 'accepted'),
      ),
    )
    .orderBy(desc(suggestions.decidedAt));
  const out = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (!row.requirementId) continue;
    const reasons = out.get(row.requirementId) ?? new Map<string, string>();
    for (const u of uncoveredList.safeParse(row.payload).data?.uncovered ?? []) {
      if (!reasons.has(u.code)) reasons.set(u.code, u.reason);
    }
    out.set(row.requirementId, reasons);
  }
  return out;
}

/**
 * The facts a requirement's turn reads beside its rows, per requirement: why an accepted breakdown
 * left a BC uncovered, the traced nodes a stale design pin's approval removed or renamed (REQ-41
 * BC-10, `auto-follow.ts`), and whether its newest merge-or-drop question stands open or was answered
 * with an act core refused (REQ-41 BC-12).
 */
// every requirement read has a status-since row (filed time where no transition); a missing one is a
// broken read, refused by name rather than read as its last edit (the AGE every edit reset, dev.227)
const sinceOf = (since: ReadonlyMap<string, Date>, id: string): Date => {
  const at = since.get(id);
  if (!at)
    throw new Error(`requirement ${id} has no status-since time: statusSinceOf read no row for it`);
  return at;
};

async function besideFactsOf(ids: readonly string[]) {
  const [uncovered, follows, asked, statusSince] = await Promise.all([
    uncoveredOf(ids),
    followReadsOf(db, ids),
    mergeOrDropOf(ids),
    statusSinceOf(ids),
  ]);
  return (id: string) => ({
    statusSince: sinceOf(statusSince, id),
    uncovered: uncovered.get(id) ?? new Map<string, string>(),
    tracedChanges: (follows.get(id) ?? []).flatMap((f) => f.changes),
    mergeOrDropAsked: asked.get(id)?.open === true,
    mergeOrDropRefused: asked.get(id)?.refused ?? null,
  });
}

const by = <T extends { requirementId: string | null }>(list: readonly T[], id: string) =>
  list.filter((x) => x.requirementId === id);

/**
 * What the turn of a requirement whose issues are worked reads beyond their statuses
 * (`standing-work.ts:workTurn`): each parked issue's own standing wait, and what follows a landing,
 * read once for the page and only where a requirement's every unshipped issue has landed.
 */
async function workFactsOf(
  projectId: string,
  rows: readonly StandingRow[],
  linked: readonly { requirementId: string | null; id: string; status: string }[],
  viewer: StandingViewer | null,
  now: Date,
) {
  const parked = linked.filter((i) => PARK_STATUSES.includes(i.status as IssueStatus));
  const releaseOwed = rows.some((r) =>
    awaitsReleaseOnly(by(linked, r.id).filter((i) => i.status !== 'dropped')),
  );
  const [parkedWaits, release] = await Promise.all([
    issueWaitsOf(
      projectId,
      parked.map((i) => i.id),
      viewer ? { userId: viewer.userId } : null,
      now,
    ),
    releaseOwed ? requirementDependents().releaseLeg(projectId, viewer?.userId ?? null) : null,
  ]);
  return { parkedWaits, release };
}

/** The proposed suggestions on these requirements, by kind. */
const proposedSuggestionsOf = (ids: string[]) =>
  db
    .select({ requirementId: suggestions.requirementId, kind: suggestions.kind })
    .from(suggestions)
    .where(and(inArray(suggestions.requirementId, ids), eq(suggestions.status, 'proposed')));

/**
 * One runner bound to the project, if any, whatever its status: where none is bound no master can
 * act (FB-77); a runner briefly offline still carries its master.
 */
const runnerBoundIn = async (projectId: string): Promise<boolean> =>
  (
    await db
      .select({ id: runners.id })
      .from(runners)
      .where(eq(runners.projectId, projectId))
      .limit(1)
  ).length > 0;

/** The standing of each requirement in `rows`, keyed by id; all rows belong to `projectId`. */
export async function standingsOf(
  projectId: string,
  rows: readonly StandingRow[],
  viewer: StandingViewer | null,
  held?: StandingPreload,
  /** Facts about the project the caller read in a statement it sends anyway; absent, read here. */
  known: { runnerBound?: boolean } = {},
): Promise<Map<string, RequirementStanding>> {
  if (rows.length === 0) return new Map();
  const now = new Date();
  const ids = rows.map((r) => r.id);
  const [
    revisions,
    criteria,
    linked,
    open,
    prefix,
    pins,
    baselineSeqs,
    gates,
    contracts,
    contractPins,
    unapproved,
    policy,
    runnerBound,
  ] = await Promise.all([
    held?.revisions ??
      db
        .select({
          requirementId: requirementRevisions.requirementId,
          revision: requirementRevisions.revision,
          state: requirementRevisions.state,
          authorId: requirementRevisions.authorId,
          authorAgency: requirementRevisions.authorAgency,
          returnReason: requirementRevisions.returnReason,
          createdAt: requirementRevisions.createdAt,
          proposedAt: requirementRevisions.proposedAt,
          decidedAt: requirementRevisions.decidedAt,
        })
        .from(requirementRevisions)
        .where(inArray(requirementRevisions.requirementId, ids))
        .orderBy(desc(requirementRevisions.revision)),
    held?.criteria ??
      db
        .select({
          requirementId: requirementCriteria.requirementId,
          id: requirementCriteria.id,
          code: requirementCriteria.code,
          body: requirementCriteria.body,
          sinceRevision: requirementCriteria.sinceRevision,
          retiredRevision: requirementCriteria.retiredRevision,
        })
        .from(requirementCriteria)
        .where(inArray(requirementCriteria.requirementId, ids)),
    held?.linked ??
      db
        .select({
          requirementId: issues.requirementId,
          id: issues.id,
          issSeq: issues.issSeq,
          title: issues.title,
          status: issues.status,
          updatedAt: issues.updatedAt,
          plan: issues.plan,
          plannedRevision: issues.plannedRevision,
        })
        .from(issues)
        .where(inArray(issues.requirementId, ids))
        .orderBy(issues.issSeq),
    proposedSuggestionsOf(ids),
    held ? held.prefix : activeIssuePrefix(projectId),
    latestPinsOf(ids),
    held?.baselines ??
      db
        .select({
          requirementId: requirementBaselines.requirementId,
          revision: requirementBaselines.revision,
          seq: requirementBaselines.seq,
          agreedAt: requirementBaselines.agreedAt,
        })
        .from(requirementBaselines)
        .where(inArray(requirementBaselines.requirementId, ids)),
    held ? held.gates : documentGatesIn(projectId),
    linkedContractsOf(db, ids),
    latestContractPinsOf(ids),
    unapprovedDesignsOf(ids),
    readEffectivePolicy(projectId),
    known.runnerBound ?? runnerBoundIn(projectId),
  ]);
  const beside = await besideFactsOf(ids);
  const linkedIds = linked.map((i) => i.id);
  const [people, issueCriteria, feedbackLinks, times, changedTraced, work] = await Promise.all([
    peopleOf([...revisions.map((r) => r.authorId), ...rows.map((r) => r.ownerId)]),
    issueCriteriaOf(linkedIds),
    feedbackLinksOf(projectId, ids),
    issueTimesOf(linked),
    changedTracedOf(db, linkedIds),
    workFactsOf(projectId, rows, linked, viewer, now),
  ]);
  const { parkedWaits, release } = work;
  const liveBuild = await liveBuildOf(projectId, issueCriteria);
  const feedbackBy = feedbackCountsOf(feedbackLinks);
  const out = new Map<string, RequirementStanding>();
  for (const row of rows) {
    const mine = by(linked, row.id).map((i) => ({
      id: i.id,
      displayId: formatIssueRef(prefix, i.issSeq),
      title: i.title,
      status: i.status,
      tone: issueStatusToneOn(i.status as IssueStatus, gates.releaseApproval),
      updatedAt: i.updatedAt,
      closedAt: i.status === 'closed' ? (times.closedAt.get(i.id) ?? null) : null,
      startedAt: times.startedAt.get(i.id) ?? null,
      changedSincePlan: changedSincePlan({
        ...i,
        currentRevision: row.currentRevision,
        changedTraced: changedTraced.get(i.id) ?? [],
      }),
      parkedOn: parkedWaits.get(i.id)?.standing.waitingOn ?? null,
    }));
    const issueIds = new Set(mine.map((i) => i.id));
    out.set(
      row.id,
      deriveStanding({
        status: row.status as RequirementStatus,
        owner: ownerOf(row.ownerId, people),
        viewer,
        approvals: gates.approvals,
        revisions: by(revisions, row.id).map((r) => ({
          revision: r.revision,
          state: r.state as RevisionState,
          authorId: r.authorId,
          authorName: people.get(r.authorId)?.name ?? null,
          authorKind: people.get(r.authorId)?.kind ?? 'human',
          authorAgency: r.authorAgency,
          returned: r.returnReason !== null,
          createdAt: r.createdAt,
          proposedAt: r.proposedAt,
          decidedAt: r.decidedAt,
        })),
        currentRevision: row.currentRevision,
        criteria: by(criteria, row.id),
        issues: mine,
        issueCriteria: issueCriteria.filter((c) => issueIds.has(c.issueId)),
        openSuggestionKinds: by(open, row.id).map((s) => s.kind),
        ...beside(row.id),
        liveBuild,
        stalePins: stalePinsOf(by(pins, row.id)),
        staleContractPins: staleContractPinsOf(by(contracts, row.id), by(contractPins, row.id)),
        unapprovedDesigns: by(unapproved, row.id).map(({ flow, title, designStatus }) => ({
          flow,
          title,
          designStatus,
        })),
        feedback: feedbackBy.get(row.id) ?? { open: 0, untriaged: [] },
        judge: policy?.document.qa ?? null,
        runnerBound,
        agreedAt: firstBaselineAt(baselineSeqs, row.id, row.currentRevision),
        release: awaitsReleaseOnly(mine.filter((i) => i.status !== 'dropped')) ? release : null,
        updatedAt: row.updatedAt,
        now,
      }),
    );
  }
  return out;
}

/** Each of `ids`' state as its own standing reads it, for a reader outside the module. */
export async function requirementStatesOf(
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, RequirementState>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      ownerId: requirements.ownerId,
      updatedAt: requirements.updatedAt,
    })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), inArray(requirements.id, [...ids])));
  const standings = await standingsOf(projectId, rows, null);
  return new Map([...standings].map(([id, s]) => [id, s.state]));
}

/** Which of `ids` read delivered (`standing.ts:deliveryOf`) or were accepted. */
export async function deliveredAmong(
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      ownerId: requirements.ownerId,
      updatedAt: requirements.updatedAt,
    })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), inArray(requirements.id, [...ids])));
  const standings = await standingsOf(projectId, rows, null);
  return new Set(
    rows
      .filter((r) => r.status === 'accepted' || standings.get(r.id)?.state === 'delivered')
      .map((r) => r.id),
  );
}

/**
 * One business criterion's coverage as its requirement's standing reads it now: the verdict of the
 * newest judgement on the issue criteria tracing it, checked against what the running build holds,
 * and why where none counts. Null where the requirement or the criterion is not current.
 */
export async function criterionVerdictOf(
  projectId: string,
  requirementId: string,
  code: string,
): Promise<{ verdict: BcVerdict; why: string | null } | null> {
  const rows = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      ownerId: requirements.ownerId,
      updatedAt: requirements.updatedAt,
    })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), eq(requirements.id, requirementId)));
  const standing = (await standingsOf(projectId, rows, null)).get(requirementId);
  const found = standing?.coverage.find((c) => c.code === code);
  return found ? { verdict: found.verdict, why: found.why } : null;
}
