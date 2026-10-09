import { ISSUE_ADMIT_PERMISSION, type IssueStatus } from '@forge/contracts/issue-machine';
import { issueStatusToneOn } from '@forge/contracts/issue-vocabulary';
import type { ActorAgency } from '@forge/contracts/permissions';
import {
  type ChangedTrace,
  changedSincePlan,
  type RequirementDetail,
  type RequirementSpec,
  type RequirementStanding,
  type RequirementSummary,
  requirementKey,
} from '@forge/contracts/requirements';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
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
import { dataPolicyOf, egressReading } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { notFound } from '../middleware/route-errors.js';
import {
  actorFor,
  permissionFactsOf,
  permissionRefusal,
  projectResource,
  requireCan,
} from '../permissions/index.js';
import { linkedContracts } from './baselines.js';
import { latestBaselineBindingsOf, withBuildingIssues } from './bindings.js';
import { questionViewsOf } from './clarity.js';
import { tracesOf } from './criterion-traces.js';
import { deferralOf } from './deferral-read.js';
import { requirementDependents } from './dependents.js';
import { historyOf } from './history-read.js';
import { dedupCheckOf } from './near-duplicate.js';
import { pictureRowsOf } from './picture-read.js';
import { changedTracedOf } from './plan-drift.js';
import { requestedByOf, requestSignoffRefusal, requestViewOf } from './request-signoff.js';
import { criterionView, revisionView } from './revision-view.js';
import { type LinkedDesign, liveAt, type ReadinessAtHead, signoffRefusal } from './rules.js';
import { releasesOf, type ShippedRelease, shippedReleasesOf } from './shipped-read.js';
import { approvalRequiredIn, standingsOf } from './standing-read.js';

export interface RequirementActor {
  userId: string;
  agency: ActorAgency;
}

export type Row = typeof requirements.$inferSelect;
export type { CriterionRow, RevisionRow } from './revision-view.js';

/** Where a requirement ref (uuid, `REQ-n` or `n`) names a row of `projectId`; null for neither shape. */
function refWhere(projectId: string, ref: string) {
  const seq = /^(?:REQ-)?(\d{1,9})$/i.exec(ref.trim())?.[1];
  const uuid = /^[0-9a-f-]{36}$/i.test(ref) ? ref : null;
  if (!seq && !uuid) return null;
  return and(
    eq(requirements.projectId, projectId),
    seq ? eq(requirements.reqSeq, Number(seq)) : eq(requirements.id, uuid as string),
  );
}

/** A requirement of `projectId` by uuid, `REQ-n` or `n`; 404 otherwise. */
export async function rowIn(tx: Tx, projectId: string, ref: string): Promise<Row> {
  const where = refWhere(projectId, ref);
  if (!where) throw notFound(`"${ref}" is neither a requirement uuid nor a key like REQ-12`);
  const [row] = await tx.select().from(requirements).where(where);
  if (!row) throw notFound(`project ${projectId} holds no requirement ${ref}`);
  return row;
}

/** The requirement `ref` (REQ-n or uuid) names in the project, or null when it names none. */
export async function requirementIdIn(tx: Tx, projectId: string, ref: string) {
  const where = refWhere(projectId, ref);
  if (!where) return null;
  const [row] = await tx.select({ id: requirements.id }).from(requirements).where(where);
  return row?.id ?? null;
}

/** `row` is the requirement being signed, when there is one: a contract request is signed only here. */
export async function signerRefusal(
  actor: RequirementActor,
  projectId: string,
  act: string,
  row?: Pick<Row, 'requestedByProjectId' | 'reqSeq'>,
) {
  const refusal = signoffRefusal(await permissionFactsOf(actor.userId, projectId), act);
  if (!refusal || !row?.requestedByProjectId) return refusal;
  const requestedBy = await requestedByOf(row);
  return requestSignoffRefusal({
    refusal,
    key: requirementKey(row.reqSeq),
    requestedBy,
    signerInRequestingProject:
      !!requestedBy && (await permissionFactsOf(actor.userId, requestedBy.id)).role !== null,
  });
}

export async function linkedDesigns(
  tx: Tx,
  requirementId: string,
): Promise<(LinkedDesign & { title: string | null })[]> {
  const rows = await tx
    .select({
      workflowId: projectWorkflows.id,
      flow: projectWorkflows.flow,
      title: sql<string | null>`${projectWorkflows.document}->>'title'`,
      designStatus: projectWorkflows.designStatus,
      approvedRevision: projectWorkflows.approvedRevision,
    })
    .from(requirementWorkflows)
    .innerJoin(projectWorkflows, eq(projectWorkflows.id, requirementWorkflows.workflowId))
    .where(eq(requirementWorkflows.requirementId, requirementId))
    .orderBy(asc(projectWorkflows.flow));
  return rows;
}

export function summaryOf(
  row: Row,
  latest: { revision: number; state: RevisionState } | null,
  delivery: RequirementStanding['delivery'],
): Omit<RequirementSummary, 'standing'> {
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

/** What the viewer may do here: sign off (requirements.approve), and admit a draft issue (issues.admit). */
export async function standingViewer(viewer: RequirementActor | null, projectId: string) {
  if (!viewer) return null;
  const facts = await permissionFactsOf(viewer.userId, projectId);
  return {
    userId: viewer.userId,
    canSignOff: signoffRefusal(facts, 'a sign-off') === null,
    canAdmit: permissionRefusal(facts, ISSUE_ADMIT_PERMISSION) === null,
  };
}

export async function listRequirementsAs(
  viewer: RequirementActor,
  projectId: string,
): Promise<RequirementSummary[]> {
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

type ReadinessPayload = { checks?: { check: string; passed: boolean }[] } | null;

// Workflow requirement-to-delivery step `ready`: readiness is a suggestion kind with no
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

const NO_PERSON: RequirementActor = { userId: '', agency: 'agent' };

function detailRowsOf(requirementId: string) {
  return Promise.all([
    db
      .select()
      .from(requirementRevisions)
      .where(eq(requirementRevisions.requirementId, requirementId))
      .orderBy(desc(requirementRevisions.revision)),
    db
      .select()
      .from(requirementCriteria)
      .where(eq(requirementCriteria.requirementId, requirementId)),
    linkedDesigns(db, requirementId),
    db
      .select()
      .from(requirementBaselines)
      .where(eq(requirementBaselines.requirementId, requirementId))
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
      .where(eq(requirementBaselinePins.requirementId, requirementId)),
    db
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
        requirementId: issues.requirementId,
        plan: issues.plan,
        plannedRevision: issues.plannedRevision,
      })
      .from(issues)
      .where(eq(issues.requirementId, requirementId))
      .orderBy(asc(issues.issSeq)),
  ]);
}

type DetailRows = Awaited<ReturnType<typeof detailRowsOf>>;

function baselineViews(
  baselines: DetailRows[3],
  pins: DetailRows[4],
  name: (id: string | null) => string | null,
) {
  return baselines.map((b) => ({
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
  }));
}

function issueViews(
  row: Row,
  linked: DetailRows[5],
  changedTraced: Map<string, ChangedTrace[]>,
  prefix: string | null,
  releaseApproval: boolean,
  shipped: ReadonlyMap<string, ShippedRelease>,
) {
  return linked.map((i) => ({
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
      changedTraced: changedTraced.get(i.id) ?? [],
    }),
    shippedIn: shipped.get(i.id) ?? null,
  }));
}

export async function detailOf(
  row: Row,
  viewer: RequirementActor | null,
  door: ReadDoor = {},
): Promise<RequirementDetail> {
  const [
    [revisions, criteria, designs, baselines, pins, linked],
    prefix,
    viewerFacts,
    history,
    readiness,
    deferral,
    dedup,
    releaseApproval,
    feedback,
    traces,
    contracts,
    pictures,
  ] = await Promise.all([
    detailRowsOf(row.id),
    activeIssuePrefix(row.projectId),
    standingViewer(viewer, row.projectId),
    historyOf(row.id, row.projectId),
    readinessOf(row),
    deferralOf(row.id, row.status),
    row.currentRevision === null ? null : dedupCheckOf(row.id),
    approvalRequiredIn(row.projectId),
    requirementDependents().feedbackOf(viewer ?? NO_PERSON, row.projectId, row.id, door),
    tracesOf(db, row.id),
    linkedContracts(db, row.id),
    pictureRowsOf(row.id),
  ]);
  const [bindings, request, questions] = await Promise.all([
    latestBaselineBindingsOf(db, baselines, pins).then((b) =>
      withBuildingIssues(db, row.id, b, prefix),
    ),
    requestViewOf(row),
    dataPolicyOf(row.projectId).then((level) =>
      questionViewsOf(
        db,
        row.id,
        revisions.map((r) => r.spec as RequirementSpec),
        egressReading(
          level,
          { agency: viewer?.agency ?? 'agent', providerBound: door.providerBound },
          'requirement.clarification',
        ).withhold,
      ),
    ),
  ]);
  const [people, standings, changedTraced, shipped] = await Promise.all([
    peopleOf([
      ...revisions.flatMap((r) => [r.authorId, r.decidedBy]),
      ...baselines.map((b) => b.agreedBy),
      ...pictures.map((p) => p.writtenBy),
    ]),
    standingsOf(row.projectId, [row], viewerFacts, {
      revisions,
      criteria,
      linked,
      baselines,
      prefix,
      releaseApproval,
    }),
    changedTracedOf(
      db,
      linked.map((i) => i.id),
    ),
    shippedReleasesOf(
      row.projectId,
      linked.map((i) => i.id),
    ),
  ]);
  const standing = standings.get(row.id) as RequirementStanding;
  const name = (id: string | null) => (id === null ? null : (people.get(id)?.name ?? null));
  const latest = revisions[0];
  return {
    ...summaryOf(
      row,
      latest ? { revision: latest.revision, state: latest.state as RevisionState } : null,
      standing.delivery,
    ),
    revisions: revisions.map((r) => revisionView(r, criteria, people, pictures)),
    criteria:
      row.currentRevision === null ? [] : liveAt(criteria, row.currentRevision).map(criterionView),
    workflows: designs.map((d) => ({ ...d, title: d.title ?? d.flow })),
    contracts,
    traces,
    baselines: baselineViews(baselines, pins, name),
    issues: issueViews(row, linked, changedTraced, prefix, releaseApproval, shipped),
    releases: releasesOf(shipped),
    canSignOff: viewerFacts?.canSignOff ?? false,
    canPromote: (viewerFacts?.canSignOff && viewerFacts.canAdmit) ?? false,
    standing,
    history,
    readiness,
    dedup,
    deferral,
    feedback,
    request,
    bindings,
    questions,
    unclear: questions.filter((q) => q.status === 'open').length,
  };
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

export async function readRequirementAs(
  viewer: RequirementActor,
  projectId: string,
  ref: string,
  door: ReadDoor = {},
): Promise<RequirementDetail> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  return detailOf(await rowIn(db, projectId, ref), viewer, door);
}
