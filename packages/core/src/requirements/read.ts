/**
 * The reads of requirements: the list, the detail a person or an agent opens, and the helpers
 * every write resolves a requirement and its signer with.
 */

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { issueStatusToneOn } from '@forge/contracts/issue-vocabulary';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { RequirementStanding } from '@forge/contracts/requirements';
import { changedSincePlan, requirementKey } from '@forge/contracts/requirements';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  type CriterionForm,
  type RequirementStatus,
  type RevisionState,
  requirementBaselinePins,
  requirementBaselines,
  requirementCriteria,
  requirementRevisions,
  requirements,
  requirementWorkflows,
} from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import type { ReadDoor } from '../feedback/index.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type Person, peopleOf } from '../lib/people.js';
import { actorFor, permissionFactsOf, projectResource, requireCan } from '../permissions/index.js';
import { linkedContracts } from './baselines.js';
import { tracesOf } from './criterion-traces.js';
import { deferralOf } from './deferral-read.js';
import { requirementDependents } from './dependents.js';
import { historyOf } from './history-read.js';
import { type LinkedDesign, type ReadinessAtHead, signoffRefusal } from './rules.js';
import { approvalRequiredIn, standingsOf } from './standing-read.js';

export interface RequirementActor {
  userId: string;
  agency: ActorAgency;
}

export interface RequirementSpec {
  goal?: string | undefined;
  personas?: string[] | undefined;
  scopeIn?: string[] | undefined;
  scopeOut?: string[] | undefined;
}

export type Row = typeof requirements.$inferSelect;
export type RevisionRow = typeof requirementRevisions.$inferSelect;
export type CriterionRow = typeof requirementCriteria.$inferSelect;

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const NO_PERSON: RequirementActor = { userId: '', agency: 'agent' };

/** A requirement of `projectId` by uuid, `REQ-n` or `n`; 404 otherwise. */
export async function rowIn(tx: Tx, projectId: string, ref: string): Promise<Row> {
  const seq = /^(?:REQ-)?(\d{1,9})$/i.exec(ref.trim())?.[1];
  const uuid = /^[0-9a-f-]{36}$/i.test(ref) ? ref : null;
  if (!seq && !uuid) throw notFound(`"${ref}" is neither a requirement uuid nor a key like REQ-12`);
  const [row] = await tx
    .select()
    .from(requirements)
    .where(
      and(
        eq(requirements.projectId, projectId),
        seq ? eq(requirements.reqSeq, Number(seq)) : eq(requirements.id, uuid as string),
      ),
    );
  if (!row) throw notFound(`project ${projectId} holds no requirement ${ref}`);
  return row;
}

export async function signerRefusal(actor: RequirementActor, projectId: string, act: string) {
  return signoffRefusal(await permissionFactsOf(actor.userId, projectId), act);
}

const rowsOfRevision = (rows: readonly CriterionRow[], revision: number) =>
  rows
    .filter(
      (c) =>
        c.sinceRevision <= revision && (c.retiredRevision === null || c.retiredRevision > revision),
    )
    .sort((a, b) => Number(a.code.slice(3)) - Number(b.code.slice(3)));

const criterionView = (c: CriterionRow) => ({
  id: c.id,
  code: c.code,
  body: c.body,
  form: c.form as CriterionForm,
  sinceRevision: c.sinceRevision,
  retiredRevision: c.retiredRevision,
});

export async function linkedDesigns(tx: Tx, requirementId: string): Promise<LinkedDesign[]> {
  const rows = await tx
    .select({
      workflowId: projectWorkflows.id,
      flow: projectWorkflows.flow,
      designStatus: projectWorkflows.designStatus,
      approvedRevision: projectWorkflows.approvedRevision,
    })
    .from(requirementWorkflows)
    .innerJoin(projectWorkflows, eq(projectWorkflows.id, requirementWorkflows.workflowId))
    .where(eq(requirementWorkflows.requirementId, requirementId))
    .orderBy(asc(projectWorkflows.flow));
  return rows;
}

function summaryOf(
  row: Row,
  latest: { revision: number; state: RevisionState } | null,
  delivery: RequirementStanding['delivery'],
) {
  return {
    id: row.id,
    key: requirementKey(row.reqSeq),
    title: row.title,
    status: row.status as RequirementStatus,
    currentRevision: row.currentRevision,
    latestRevision: latest,
    delivery,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type RequirementSummary = ReturnType<typeof summaryOf>;

async function standingViewer(viewer: RequirementActor | null, projectId: string) {
  if (!viewer) return null;
  const refusal = await signerRefusal(viewer, projectId, 'a sign-off');
  return { userId: viewer.userId, canSignOff: refusal === null };
}

export async function listRequirementsAs(viewer: RequirementActor, projectId: string) {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const rows = await db
    .select()
    .from(requirements)
    .where(eq(requirements.projectId, projectId))
    .orderBy(desc(requirements.reqSeq));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [latest, standings] = await Promise.all([
    db
      .selectDistinctOn([requirementRevisions.requirementId], {
        requirementId: requirementRevisions.requirementId,
        revision: requirementRevisions.revision,
        state: requirementRevisions.state,
      })
      .from(requirementRevisions)
      .where(inArray(requirementRevisions.requirementId, ids))
      .orderBy(requirementRevisions.requirementId, desc(requirementRevisions.revision)),
    standingViewer(viewer, projectId).then((v) => standingsOf(projectId, rows, v)),
  ]);
  const latestBy = new Map(latest.map((l) => [l.requirementId, l]));
  return rows.map((r) => {
    const l = latestBy.get(r.id);
    const standing = standings.get(r.id) as RequirementStanding;
    return {
      ...summaryOf(
        r,
        l ? { revision: l.revision, state: l.state as RevisionState } : null,
        standing.delivery,
      ),
      standing,
    };
  });
}

export async function detailOf(row: Row, viewer: RequirementActor | null, door: ReadDoor = {}) {
  const [
    revisions,
    criteria,
    designs,
    baselines,
    pins,
    linked,
    prefix,
    standing,
    history,
    readiness,
    deferral,
    releaseApproval,
    feedback,
    traces,
    contracts,
  ] = await Promise.all([
    db
      .select()
      .from(requirementRevisions)
      .where(eq(requirementRevisions.requirementId, row.id))
      .orderBy(desc(requirementRevisions.revision)),
    db.select().from(requirementCriteria).where(eq(requirementCriteria.requirementId, row.id)),
    db
      .select({
        workflowId: projectWorkflows.id,
        flow: projectWorkflows.flow,
        title: sql<string | null>`${projectWorkflows.document}->>'title'`,
        designStatus: projectWorkflows.designStatus,
        approvedRevision: projectWorkflows.approvedRevision,
      })
      .from(requirementWorkflows)
      .innerJoin(projectWorkflows, eq(projectWorkflows.id, requirementWorkflows.workflowId))
      .where(eq(requirementWorkflows.requirementId, row.id))
      .orderBy(asc(projectWorkflows.flow)),
    db
      .select()
      .from(requirementBaselines)
      .where(eq(requirementBaselines.requirementId, row.id))
      .orderBy(desc(requirementBaselines.revision), desc(requirementBaselines.seq)),
    db
      .select({
        revision: requirementBaselinePins.revision,
        baselineSeq: requirementBaselinePins.baselineSeq,
        workflowId: requirementBaselinePins.workflowId,
        flow: projectWorkflows.flow,
        designRevision: requirementBaselinePins.designRevision,
        providerProjectId: requirementBaselinePins.providerProjectId,
        contractSlug: requirementBaselinePins.contractSlug,
        contractVersion: requirementBaselinePins.contractVersion,
        mockupId: requirementBaselinePins.mockupId,
      })
      .from(requirementBaselinePins)
      .leftJoin(projectWorkflows, eq(projectWorkflows.id, requirementBaselinePins.workflowId))
      .where(eq(requirementBaselinePins.requirementId, row.id)),
    db
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        status: issues.status,
        plan: issues.plan,
        plannedRevision: issues.plannedRevision,
        plannedBaselineSeq: issues.plannedBaselineSeq,
      })
      .from(issues)
      .where(eq(issues.requirementId, row.id))
      .orderBy(asc(issues.issSeq)),
    activeIssuePrefix(row.projectId),
    standingViewer(viewer, row.projectId)
      .then((v) => standingsOf(row.projectId, [row], v))
      .then((m) => m.get(row.id) as RequirementStanding),
    historyOf(row.id, row.projectId),
    readinessOf(row),
    deferralOf(row.id, row.status),
    approvalRequiredIn(row.projectId),
    requirementDependents().feedbackOf(viewer ?? NO_PERSON, row.projectId, row.id, door),
    tracesOf(db, row.id),
    linkedContracts(db, row.id),
  ]);
  const people = await peopleOf([
    ...revisions.flatMap((r) => [r.authorId, r.decidedBy]),
    ...baselines.map((b) => b.agreedBy),
  ]);
  const name = (id: string | null) => (id === null ? null : (people.get(id)?.name ?? null));
  const latest = revisions[0];
  return {
    ...summaryOf(
      row,
      latest ? { revision: latest.revision, state: latest.state as RevisionState } : null,
      standing.delivery,
    ),
    revisions: revisions.map((r) => revisionView(r, criteria, people)),
    criteria:
      row.currentRevision === null
        ? []
        : rowsOfRevision(criteria, row.currentRevision).map(criterionView),
    workflows: designs.map((d) => ({ ...d, title: d.title ?? d.flow })),
    contracts,
    traces,
    baselines: baselines.map((b) => ({
      revision: b.revision,
      seq: b.seq,
      act: b.act,
      agreedBy: b.agreedBy,
      agreedByName: name(b.agreedBy),
      agreedAt: b.agreedAt.toISOString(),
      reason: b.reason,
      readiness: b.readiness,
      pins: pins
        .filter((p) => p.revision === b.revision && p.baselineSeq === b.seq)
        .map((p) => ({
          kind: p.workflowId
            ? ('workflow-design' as const)
            : p.mockupId
              ? ('mockup' as const)
              : ('contract-version' as const),
          workflowId: p.workflowId,
          flow: p.flow,
          designRevision: p.designRevision,
          providerProjectId: p.providerProjectId,
          contractSlug: p.contractSlug,
          contractVersion: p.contractVersion,
          mockupId: p.mockupId,
        })),
    })),
    issues: linked.map((i) => ({
      issueId: i.id,
      displayId: formatIssueRef(prefix, i.issSeq),
      title: i.title,
      status: i.status,
      // awaiting_release is a person's turn only where this project requires a release approval
      tone: issueStatusToneOn(i.status as IssueStatus, releaseApproval),
      plannedRevision: i.plannedRevision,
      changedSincePlan: changedSincePlan({
        ...i,
        currentRevision: row.currentRevision,
        latestBaselineSeq: baselines.find((b) => b.revision === row.currentRevision)?.seq ?? null,
      }),
    })),
    canSignOff: viewer
      ? (await signerRefusal(viewer, row.projectId, 'a sign-off')) === null
      : false,
    standing,
    history,
    readiness,
    deferral,
    feedback,
  };
}

function revisionView(
  r: RevisionRow,
  criteria: readonly CriterionRow[],
  people: ReadonlyMap<string, Person>,
) {
  const name = (id: string | null) => (id === null ? null : (people.get(id)?.name ?? null));
  return {
    revision: r.revision,
    state: r.state as RevisionState,
    baseRevision: r.baseRevision,
    spec: r.spec as RequirementSpec,
    tldr: r.tldr,
    changeSummary: r.changeSummary,
    reason: r.reason,
    authorId: r.authorId,
    authorName: name(r.authorId),
    authorKind: people.get(r.authorId)?.kind ?? ('human' as const),
    createdAt: r.createdAt.toISOString(),
    proposedAt: r.proposedAt?.toISOString() ?? null,
    decidedBy: r.decidedBy,
    decidedByName: name(r.decidedBy),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    returnReason: r.returnReason,
    acceptReason: r.acceptReason,
    fromSuggestionId: r.fromSuggestionId,
    criteria: rowsOfRevision(criteria, r.revision).map(criterionView),
  };
}

type ReadinessPayload = { checks?: { check: string; passed: boolean }[] } | null;

// cm:why workflow requirement-to-delivery step `ready`: readiness is a suggestion kind with no
// table, so the readiness result at a revision is the newest accepted readiness suggestion on it
export async function readinessAt(
  tx: Tx,
  requirementId: string,
  revision: number,
): Promise<(ReadinessAtHead & { decidedAt: Date | null }) | null> {
  const [s] = await tx
    .select({
      id: suggestions.id,
      payload: suggestions.payload,
      decidedAt: suggestions.decidedAt,
    })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.requirementId, requirementId),
        eq(suggestions.kind, 'readiness'),
        eq(suggestions.status, 'accepted'),
        eq(suggestions.baseRevision, revision),
      ),
    )
    .orderBy(desc(suggestions.decidedAt))
    .limit(1);
  if (!s) return null;
  const failed = ((s.payload as ReadinessPayload)?.checks ?? [])
    .filter((c) => !c.passed)
    .map((c) => c.check);
  return { suggestionId: s.id, failed, decidedAt: s.decidedAt };
}

async function readinessOf(row: Row) {
  if (row.currentRevision === null) return null;
  const s = await readinessAt(db, row.id, row.currentRevision);
  if (!s) return null;
  return {
    revision: row.currentRevision,
    ready: s.failed.length === 0,
    failed: s.failed,
    suggestionId: s.suggestionId,
    decidedAt: s.decidedAt?.toISOString() ?? null,
  };
}

export type RequirementDetail = Awaited<ReturnType<typeof detailOf>>;

export async function readRequirementAs(
  viewer: RequirementActor,
  projectId: string,
  ref: string,
  door: ReadDoor = {},
): Promise<RequirementDetail> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  return detailOf(await rowIn(db, projectId, ref), viewer, door);
}
