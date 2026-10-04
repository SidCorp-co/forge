/**
 * Gathers the facts `standing.ts` derives from, for a page of requirements at once; the history a
 * requirement's page reads is `history-read.ts`.
 */

import { issueStatusToneOn, type KernelIssueStatus } from '@forge/contracts/issue-vocabulary';
import type { RequirementStanding } from '@forge/contracts/requirements';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  type DeliveryPhase,
  type RequirementStatus,
  type RevisionState,
  requirementBaselines,
  requirementCriteria,
  requirementDelivery,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { approvalRequired } from '../release-batch/approvals.js';
import { linkedContractsOf } from './baselines.js';
import { feedbackCountsOf, feedbackLinksOf } from './feedback-links.js';
import { changedSincePlan, staleContractPinsOf, stalePinsOf } from './rules.js';
import { deriveStanding } from './standing.js';
import {
  closedAtOf,
  issueCriteriaOf,
  latestContractPinsOf,
  latestPinsOf,
} from './standing-facts.js';

export interface StandingRow {
  id: string;
  projectId: string;
  status: string;
  currentRevision: number | null;
  ownerId: string | null;
  updatedAt: Date;
}

export interface StandingViewer {
  userId: string;
  canSignOff: boolean;
}

const latestSeqAt = (
  rows: readonly { requirementId: string; revision: number; seq: number }[],
  id: string,
  revision: number | null,
) =>
  rows.reduce<number | null>(
    (m, b) => (b.requirementId === id && b.revision === revision ? Math.max(m ?? 0, b.seq) : m),
    null,
  );

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

/** The standing of each requirement in `rows`, keyed by id; all rows belong to `projectId`. */
export async function standingsOf(
  projectId: string,
  rows: readonly StandingRow[],
  viewer: StandingViewer | null,
  now: Date = new Date(),
): Promise<Map<string, RequirementStanding>> {
  if (rows.length === 0) return new Map();
  const ids = rows.map((r) => r.id);
  const [
    revisions,
    criteria,
    delivery,
    linked,
    open,
    prefix,
    pins,
    baselineSeqs,
    releaseApproval,
    contracts,
    contractPins,
  ] = await Promise.all([
    db
      .select({
        requirementId: requirementRevisions.requirementId,
        revision: requirementRevisions.revision,
        state: requirementRevisions.state,
        authorId: requirementRevisions.authorId,
        createdAt: requirementRevisions.createdAt,
        proposedAt: requirementRevisions.proposedAt,
        decidedAt: requirementRevisions.decidedAt,
      })
      .from(requirementRevisions)
      .where(inArray(requirementRevisions.requirementId, ids))
      .orderBy(desc(requirementRevisions.revision)),
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
    db.select().from(requirementDelivery).where(inArray(requirementDelivery.requirementId, ids)),
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
        plannedBaselineSeq: issues.plannedBaselineSeq,
      })
      .from(issues)
      .where(inArray(issues.requirementId, ids))
      .orderBy(issues.issSeq),
    db
      .select({ requirementId: suggestions.requirementId, kind: suggestions.kind })
      .from(suggestions)
      .where(and(inArray(suggestions.requirementId, ids), eq(suggestions.status, 'proposed'))),
    activeIssuePrefix(projectId),
    latestPinsOf(ids),
    db
      .select({
        requirementId: requirementBaselines.requirementId,
        revision: requirementBaselines.revision,
        seq: requirementBaselines.seq,
        agreedAt: requirementBaselines.agreedAt,
      })
      .from(requirementBaselines)
      .where(inArray(requirementBaselines.requirementId, ids)),
    approvalRequired(projectId),
    linkedContractsOf(db, ids),
    latestContractPinsOf(ids),
  ]);
  const [people, issueCriteria, feedbackLinks, closedAt] = await Promise.all([
    peopleOf([...revisions.map((r) => r.authorId), ...rows.map((r) => r.ownerId)]),
    issueCriteriaOf(linked.map((i) => i.id)),
    feedbackLinksOf(projectId, ids),
    closedAtOf(linked.filter((i) => i.status === 'closed').map((i) => i.id)),
  ]);
  const feedbackBy = feedbackCountsOf(feedbackLinks);
  const by = <T extends { requirementId: string | null }>(list: readonly T[], id: string) =>
    list.filter((x) => x.requirementId === id);
  const phaseBy = new Map(delivery.map((d) => [d.requirementId, d.phase as DeliveryPhase | null]));
  const out = new Map<string, RequirementStanding>();
  for (const row of rows) {
    const mine = by(linked, row.id).map((i) => ({
      id: i.id,
      displayId: formatIssueRef(prefix, i.issSeq),
      title: i.title,
      status: i.status,
      tone: issueStatusToneOn(i.status as KernelIssueStatus, releaseApproval),
      updatedAt: i.updatedAt,
      closedAt: i.status === 'closed' ? (closedAt.get(i.id) ?? null) : null,
      changedSincePlan: changedSincePlan({
        ...i,
        currentRevision: row.currentRevision,
        latestBaselineSeq: latestSeqAt(baselineSeqs, row.id, row.currentRevision),
      }),
    }));
    const issueIds = new Set(mine.map((i) => i.id));
    out.set(
      row.id,
      deriveStanding({
        status: row.status as RequirementStatus,
        phase: phaseBy.get(row.id) ?? null,
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
          createdAt: r.createdAt,
          proposedAt: r.proposedAt,
          decidedAt: r.decidedAt,
        })),
        currentRevision: row.currentRevision,
        criteria: by(criteria, row.id),
        issues: mine,
        issueCriteria: issueCriteria.filter((c) => issueIds.has(c.issueId)),
        openSuggestionKinds: by(open, row.id).map((s) => s.kind),
        stalePins: stalePinsOf(by(pins, row.id)),
        staleContractPins: staleContractPinsOf(by(contracts, row.id), by(contractPins, row.id)),
        feedback: feedbackBy.get(row.id) ?? { open: 0, untriaged: [] },
        agreedAt: firstBaselineAt(baselineSeqs, row.id, row.currentRevision),
        updatedAt: row.updatedAt,
        now,
      }),
    );
  }
  return out;
}

/** Which of `ids` read delivered (proven, `standing.ts:provenPhase`) or were accepted. */
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
