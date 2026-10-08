/**
 * Gathers the facts `standing.ts` derives from, for a page of requirements at once; the history a
 * requirement's page reads is `history-read.ts`.
 */

import { type IssueStatus, PARK_STATUSES } from '@forge/contracts/issue-machine';
import { issueStatusToneOn } from '@forge/contracts/issue-vocabulary';
import { releaseApprovalRequired } from '@forge/contracts/releases';
import type { RequirementStanding, RequirementState } from '@forge/contracts/requirements';
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
import { suggestions } from '../db/schema-suggestions.js';
import { activeIssuePrefix, issueWaitsOf } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { readEffectivePolicy, readProjectDocument } from '../project-config/index.js';
import { linkedContractsOf } from './baselines.js';
import { requirementDependents } from './dependents.js';
import { feedbackCountsOf, feedbackLinksOf } from './feedback-links.js';
import { changedTracedOf } from './plan-drift.js';
import { staleContractPinsOf, stalePinsOf } from './rules.js';
import { deriveStanding } from './standing.js';
import {
  closedAtOf,
  issueCriteriaOf,
  latestContractPinsOf,
  latestPinsOf,
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
  releaseApproval: boolean;
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

/** Whether `projectId`'s document requires a release approval, by the one predicate release reads too. */
export async function approvalRequiredIn(projectId: string): Promise<boolean> {
  return releaseApprovalRequired((await readProjectDocument(projectId))?.document);
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

/** The standing of each requirement in `rows`, keyed by id; all rows belong to `projectId`. */
export async function standingsOf(
  projectId: string,
  rows: readonly StandingRow[],
  viewer: StandingViewer | null,
  held?: StandingPreload,
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
    releaseApproval,
    contracts,
    contractPins,
    unapproved,
    policy,
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
    db
      .select({ requirementId: suggestions.requirementId, kind: suggestions.kind })
      .from(suggestions)
      .where(and(inArray(suggestions.requirementId, ids), eq(suggestions.status, 'proposed'))),
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
    held ? held.releaseApproval : approvalRequiredIn(projectId),
    linkedContractsOf(db, ids),
    latestContractPinsOf(ids),
    unapprovedDesignsOf(ids),
    readEffectivePolicy(projectId),
  ]);
  const uncovered = await uncoveredOf(ids);
  const [people, issueCriteria, feedbackLinks, closedAt, changedTraced, work] = await Promise.all([
    peopleOf([...revisions.map((r) => r.authorId), ...rows.map((r) => r.ownerId)]),
    issueCriteriaOf(linked.map((i) => i.id)),
    feedbackLinksOf(projectId, ids),
    closedAtOf(linked.filter((i) => i.status === 'closed').map((i) => i.id)),
    changedTracedOf(
      db,
      linked.map((i) => i.id),
    ),
    workFactsOf(projectId, rows, linked, viewer, now),
  ]);
  const { parkedWaits, release } = work;
  const feedbackBy = feedbackCountsOf(feedbackLinks);
  const out = new Map<string, RequirementStanding>();
  for (const row of rows) {
    const mine = by(linked, row.id).map((i) => ({
      id: i.id,
      displayId: formatIssueRef(prefix, i.issSeq),
      title: i.title,
      status: i.status,
      tone: issueStatusToneOn(i.status as IssueStatus, releaseApproval),
      updatedAt: i.updatedAt,
      closedAt: i.status === 'closed' ? (closedAt.get(i.id) ?? null) : null,
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
        owner: row.ownerId
          ? {
              id: row.ownerId,
              name: people.get(row.ownerId)?.name ?? null,
              kind: people.get(row.ownerId)?.kind ?? 'human',
            }
          : null,
        viewer,
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
        uncovered: uncovered.get(row.id) ?? new Map(),
        stalePins: stalePinsOf(by(pins, row.id)),
        staleContractPins: staleContractPinsOf(by(contracts, row.id), by(contractPins, row.id)),
        unapprovedDesigns: by(unapproved, row.id).map(({ flow, title, designStatus }) => ({
          flow,
          title,
          designStatus,
        })),
        feedback: feedbackBy.get(row.id) ?? { open: 0, untriaged: [] },
        judge: policy?.document.qa ?? null,
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
