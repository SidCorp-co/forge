import {
  emptyHealthCounts,
  rewriteThresholdOf,
  type WorkflowHealth,
  type WorkflowHealthSummary,
} from '@forge/contracts/workflow-health';
import { resolveProjectTemplates } from '@forge/contracts/workflow-templates';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, permissionFactsOf, projectResource, requireCan } from '../permissions/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { designApproverRefusal } from './design.js';
import { standingBaseRefusal } from './design-bases.js';
import { designWaitingOn } from './design-standing.js';
import {
  buildsOf,
  contractPinsOf,
  criteriaOf,
  date,
  decisionsOf,
  designRowsOf,
  observationOf,
  rowsOf,
  suggestionsOf,
} from './health-inputs.js';
import { type HealthViewer, openFeedbackOf } from './health-ports.js';
import { deriveHealth, type HealthFacts, type PlannedTarget } from './health-rules.js';
import { rootedOf } from './rooted.js';
import { readStoredWorkflow } from './schema.js';
import { workflowsOf } from './store.js';
import { templateOf } from './template-check.js';

interface WorkflowRow {
  id: string;
  flow: string;
  revision: number;
  approved_revision: number | null;
  design_status: string | null;
  document: unknown;
}

/** What every design of one project shares: the viewer's acts, the project's slug, settings and feedback. */
interface ProjectHealthContext {
  projectId: string;
  slug: string;
  viewer: HealthViewer;
  canDecide: boolean;
  threshold: HealthFacts['threshold'];
  templates: ReturnType<typeof resolveProjectTemplates>['templates'];
  feedback: Awaited<ReturnType<typeof openFeedbackOf>>;
  names: Map<string, { name: string | null }>;
  held: Awaited<ReturnType<typeof workflowsOf>>;
}

async function contextOf(projectId: string, viewer: HealthViewer): Promise<ProjectHealthContext> {
  const [doc, slugRows, feedback, facts, held] = await Promise.all([
    readProjectDocument(projectId),
    db.execute(sql`SELECT slug FROM projects WHERE id = ${projectId}`),
    openFeedbackOf(viewer, projectId),
    permissionFactsOf(viewer.userId, projectId),
    workflowsOf(db, projectId),
  ]);
  const workflows = doc?.document.workflows;
  return {
    projectId,
    slug: String(rowsOf<{ slug: string }>(slugRows)[0]?.slug ?? projectId),
    viewer,
    canDecide: designApproverRefusal(facts) === null,
    threshold: rewriteThresholdOf(workflows?.rewriteThreshold),
    templates: resolveProjectTemplates(workflows?.templates ?? []).templates,
    feedback,
    names: new Map(),
    held,
  };
}

async function healthOfRow(ctx: ProjectHealthContext, w: WorkflowRow): Promise<WorkflowHealth> {
  const [designs, criteria, contractPins, suggestions, builds, observation, decisions, rooted] =
    await Promise.all([
      designRowsOf(w.id),
      criteriaOf(w.id),
      contractPinsOf(w.id),
      suggestionsOf(w.id),
      buildsOf(ctx.viewer, ctx.projectId, w.id),
      observationOf(w.id),
      decisionsOf(w.id),
      rootedOf(db, { id: w.id, approvedRevision: w.approved_revision }),
    ]);
  const head = readStoredWorkflow(w.document);
  const open =
    w.design_status === 'proposed'
      ? designs.find((d) => d.revision === w.revision && d.decision === null)
      : undefined;
  const openDoc = open ? readStoredWorkflow(open.document) : null;
  const found = head ? templateOf(head, ctx.templates) : null;
  const facts: HealthFacts = {
    now: new Date(),
    workflowId: w.id,
    flow: w.flow,
    projectSlug: ctx.slug,
    head: { revision: w.revision, document: head },
    approvedRevision: w.approved_revision,
    revisions: designs.map((d) => ({
      revision: Number(d.revision),
      document: readStoredWorkflow(d.document),
      decidedAt: d.decision === 'approved' ? date(d.decided_at) : null,
    })),
    proposed:
      open && openDoc
        ? {
            revision: Number(open.revision),
            document: openDoc,
            proposedAt: new Date(open.proposed_at),
            waitingOn: designWaitingOn({
              status: 'proposed',
              proposedRevision: Number(open.revision),
              approvedRevision: w.approved_revision,
              latest: { revision: w.revision, author: null },
              canDecide: ctx.canDecide,
              baseUnapproved: standingBaseRefusal(Number(open.revision), open.document, ctx.held),
            }),
          }
        : null,
    lastProposedAt: designs.reduce<Date | null>((at, d) => {
      const p = new Date(d.proposed_at);
      return !at || p > at ? p : at;
    }, null),
    template: found?.ok ? found.template : null,
    criteria,
    contractPins,
    feedback: ctx.feedback
      .filter((f) => f.target.type === 'workflow' && f.target.key === w.flow)
      .map((f) => {
        const n = f.target.node;
        const target: PlannedTarget | null = !n
          ? null
          : 'step' in n
            ? { kind: 'step', step: n.step }
            : { kind: 'edge', from: n.edge.from, to: n.edge.to, label: n.edge.label ?? null };
        return {
          key: f.key,
          title: f.title,
          target,
          waitingOn: f.waitingOn,
          createdAt: new Date(f.createdAt),
        };
      }),
    suggestions,
    builds,
    observation,
    decisions,
    threshold: ctx.threshold,
    rooted,
  };
  return deriveHealth(facts);
}

async function workflowRowsOf(projectId: string, ref?: string): Promise<WorkflowRow[]> {
  const where =
    ref === undefined
      ? sql`true`
      : /^[0-9a-f-]{36}$/i.test(ref)
        ? sql`id = ${ref}`
        : sql`flow = ${ref.trim()}`;
  return rowsOf<WorkflowRow>(
    await db.execute(sql`
      SELECT id, flow, revision, approved_revision, design_status, document
        FROM project_workflows WHERE project_id = ${projectId} AND ${where}
       ORDER BY flow`),
  );
}

/** `GET /api/projects/:id/workflows/:workflow/health`. */
export async function readWorkflowHealthAs(
  viewer: HealthViewer,
  projectId: string,
  workflow: string,
): Promise<WorkflowHealth> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const [row] = await workflowRowsOf(projectId, workflow);
  if (!row) throw notFound(`project ${projectId} holds no workflow ${workflow}`);
  return healthOfRow(await contextOf(projectId, viewer), row);
}

export function summaryOfHealth(h: WorkflowHealth): WorkflowHealthSummary {
  return {
    counts: h.counts,
    needsYou: h.needsYou,
    workflowLevelOnly: h.markers.length > 0 && h.markers.every((m) => m.target.kind === 'workflow'),
    observed: h.observation !== null,
    reconciled: h.reconciliation.state === 'reconciled',
  };
}

export const noHealthSummary = (): WorkflowHealthSummary => ({
  counts: emptyHealthCounts(),
  needsYou: 0,
  workflowLevelOnly: false,
  observed: false,
  reconciled: false,
});

/** Every design's health of one project, by workflow id: what the workflows list and Needs you read. */
export async function projectHealthAs(
  viewer: HealthViewer,
  projectId: string,
): Promise<Map<string, WorkflowHealth>> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const [ctx, rows] = await Promise.all([contextOf(projectId, viewer), workflowRowsOf(projectId)]);
  const all = await Promise.all(rows.map((r) => healthOfRow(ctx, r)));
  return new Map(all.map((h) => [h.workflowId, h]));
}
