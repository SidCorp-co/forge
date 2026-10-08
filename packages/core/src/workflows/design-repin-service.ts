/**
 * The one act that approves a moved base's pin-only dependents (`design-repin.ts:planRepins`): read
 * as a plan before anyone acts, then taken by whoever holds `workflow-designs.approve` in one
 * transaction, each design's pin-only revision written as a re-pin by the acting person (or a filed
 * one approved as it stands) and approved, one recorded decision per design naming the act. Whether
 * a pin ever moves without that act is the owner's open rule; nothing here moves one on its own.
 */

import { randomUUID } from 'node:crypto';
import { findTemplate, type WorkflowTemplate } from '@forge/contracts/workflow-templates';
import type { RepinActResult, RepinPlan } from '@forge/contracts/workflows';
import { db, type Tx } from '../db/client.js';
import { userNames } from '../lib/people.js';
import { RefusalError } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { type DesignRefusal, designFingerprint } from './design.js';
import { standingBaseRefusal } from './design-bases.js';
import { planRepins, type RepinDesign, type RepinStep } from './design-repin.js';
import { approverRefusalFor, recordDecision } from './design-service.js';
import { reaskSupersededDesignQuestions } from './ports.js';
import { readStoredWorkflow } from './schema.js';
import { assertWriter, templatesOf, type WorkflowWriter } from './service.js';
import {
  headDesignsOf,
  insertDesign,
  lockWorkflows,
  moveDesign,
  readWorkflow,
  replaceWorkflow,
  type StoredDesign,
  type StoredWorkflow,
  workflowsOf,
} from './store.js';

interface Loaded {
  rows: StoredWorkflow[];
  designs: RepinDesign[];
  pending: Map<string, StoredDesign>;
  approvedAt: Map<string, Date | null>;
}

async function loadDesigns(
  tx: Tx,
  projectId: string,
  templates: readonly WorkflowTemplate[],
): Promise<Loaded> {
  const rows = await workflowsOf(tx, projectId);
  const heads = await headDesignsOf(tx, projectId);
  const pending = new Map<string, StoredDesign>();
  const approvedAt = new Map<string, Date | null>();
  const designs = rows.map((row): RepinDesign => {
    const own = heads.filter((h) => h.workflowId === row.id);
    const approved = own.find((h) => h.revision === row.approvedRevision);
    const newest = own[0];
    if (newest && newest.decision === null) pending.set(row.id, newest);
    approvedAt.set(row.id, approved?.decidedAt ?? null);
    const current = readStoredWorkflow(row.document);
    return {
      id: row.id,
      flow: row.flow,
      revision: row.revision,
      designStatus: row.designStatus,
      approvedRevision: row.approvedRevision,
      current,
      approved: approved ? readStoredWorkflow(approved.document) : null,
      pending:
        newest && newest.decision === null
          ? {
              revision: newest.revision,
              document: readStoredWorkflow(newest.document),
              proposedBy: newest.proposedByUser,
            }
          : null,
      template: current ? findTemplate(templates, current.template) : null,
    };
  });
  return { rows, designs, pending, approvedAt };
}

const pinWords = (step: RepinStep) =>
  step.change.pins.map((p) => `${p.workflow} r${p.from} → r${p.to}`).join(', ');

function itemOf(step: RepinStep, names: Map<string, string>) {
  const d = step.design;
  return {
    workflowId: d.id,
    flow: d.flow,
    revision: d.revision,
    approvedRevision: d.approvedRevision as number,
    source: step.source,
    approves: step.approves,
    proposedByName:
      step.source === 'proposal' && d.pending
        ? (names.get(d.pending.proposedBy) ?? d.pending.proposedBy)
        : null,
    pins: step.change.pins,
    proof: { changed: step.change.changed, fingerprint: step.change.fingerprint },
  };
}

const refusedOf = (r: { design: RepinDesign; refusal: DesignRefusal }) => ({
  workflowId: r.design.id,
  flow: r.design.flow,
  revision: r.design.revision,
  refusal: {
    code: r.refusal.code,
    path: r.refusal.path,
    detail: r.refusal.detail,
    flow: r.design.flow,
  },
});

/** What one act approving `baseId`'s pin-only dependents would do now, read before anyone acts. */
export async function readRepinPlanAs(
  viewer: WorkflowWriter,
  projectId: string,
  baseId: string,
): Promise<RepinPlan> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const { templates } = await templatesOf(projectId);
  const loaded = await loadDesigns(db, projectId, templates);
  const base = loaded.designs.find((d) => d.id === baseId);
  if (!base) throw notFound(`project ${projectId} holds no workflow ${baseId}`);
  const plan = planRepins(base.flow, loaded.designs);
  const names = await userNames(plan.ready.map((s) => s.design.pending?.proposedBy ?? null));
  return {
    base: { workflowId: base.id, flow: base.flow, approvedRevision: base.approvedRevision },
    canDecide: (await approverRefusalFor(viewer, projectId)) === null,
    ready: plan.ready.map((s) => itemOf(s, names)),
    refused: plan.refused.map(refusedOf),
  };
}

/** One moved base whose pin-only dependents one act would clear: what Needs you shows as a single row. */
export interface RepinGroup {
  baseId: string;
  flow: string;
  title: string;
  revision: number;
  /** The designs the act would approve; a filed proposal among them is not a row of its own. */
  ready: { workflowId: string; flow: string; source: RepinStep['source'] }[];
  approvedAt: string | null;
}

/** Every moved base of the project with pin-only dependents ready for the act. */
export async function repinGroupsOf(projectId: string): Promise<RepinGroup[]> {
  const rows = await workflowsOf(db, projectId);
  // a design whose document declares no base has no pin to move, as stored or as approved
  if (!rows.some((r) => readStoredWorkflow(r.document)?.basedOn)) return [];
  const { templates } = await templatesOf(projectId);
  const loaded = await loadDesigns(db, projectId, templates);
  const roots = loaded.designs.filter(
    (b) =>
      b.approvedRevision !== null &&
      loaded.designs.some((d) =>
        d.approved?.basedOn?.some(
          (p) => p.workflow === b.flow && p.revision !== b.approvedRevision,
        ),
      ),
  );
  return roots.flatMap((b): RepinGroup[] => {
    const { ready } = planRepins(b.flow, loaded.designs);
    if (ready.length === 0) return [];
    return [
      {
        baseId: b.id,
        flow: b.flow,
        title: b.current?.title ?? b.flow,
        revision: b.approvedRevision as number,
        ready: ready.map((s) => ({
          workflowId: s.design.id,
          flow: s.design.flow,
          source: s.source,
        })),
        approvedAt: loaded.approvedAt.get(b.id)?.toISOString() ?? null,
      },
    ];
  });
}

/** The project's re-pin groups as `viewer` reads them: Needs you counts one only where the viewer may take the act. */
export async function repinGroupsAs(
  viewer: WorkflowWriter,
  projectId: string,
): Promise<{ canDecide: boolean; groups: RepinGroup[] }> {
  const groups = await repinGroupsOf(projectId);
  if (groups.length === 0) return { canDecide: false, groups };
  return { canDecide: (await approverRefusalFor(viewer, projectId)) === null, groups };
}

/** Refuses the whole act, rolling its transaction back: nothing it wrote stands. */
const actRefused = (refusals: DesignRefusal[]) => new RefusalError(refusals, 'WORKFLOW_REFUSED');

export type RepinOutcome =
  | { ok: true; result: RepinActResult }
  | { ok: false; refusals: DesignRefusal[] };

/** The named designs' refusals before anything is written: each named once, read at its revision, and in the plan. */
function namedRefusals(
  named: readonly { workflowId: string; revision: number }[],
  loaded: Loaded,
  plan: ReturnType<typeof planRepins>,
  baseFlow: string,
): DesignRefusal[] {
  const ready = new Set(plan.ready.map((s) => s.design.id));
  const refused = new Map(plan.refused.map((r) => [r.design.id, r.refusal]));
  const seen = new Set<string>();
  return named.flatMap((n, i): DesignRefusal[] => {
    const path = `/designs/${i}`;
    const d = loaded.designs.find((x) => x.id === n.workflowId);
    if (!d || seen.has(n.workflowId)) {
      return [
        {
          code: 'WORKFLOW_REPIN_NOT_DEPENDENT',
          path,
          detail: d
            ? `"${d.flow}" is named twice; name each design once.`
            : `this project holds no workflow ${n.workflowId}.`,
        },
      ];
    }
    seen.add(n.workflowId);
    if (d.revision !== n.revision) {
      return [
        {
          code: 'WORKFLOW_DESIGN_REVISION_STALE',
          path: `${path}/revision`,
          flow: d.flow,
          revision: n.revision,
          detail: `"${d.flow}" was read at revision ${n.revision} and stands at revision ${d.revision} now; read the plan again, then act on what it shows.`,
        },
      ];
    }
    const refusal = refused.get(d.id);
    if (refusal) return [{ ...refusal, path, flow: d.flow }];
    if (ready.has(d.id)) return [];
    return [
      {
        code: 'WORKFLOW_REPIN_NOT_DEPENDENT',
        path,
        flow: d.flow,
        detail: `"${d.flow}" has no pin to move onto "${baseFlow}"'s approved revision: its approved revision pins the revision approved now, or it rests on nothing this act re-pins.`,
      },
    ];
  });
}

async function takeStep(
  tx: Tx,
  input: {
    projectId: string;
    step: RepinStep;
    actor: WorkflowWriter;
    reason: string;
    pending?: StoredDesign;
  },
): Promise<number> {
  const { projectId, step, actor, reason } = input;
  const d = step.design;
  const row = await readWorkflow(tx, d.id);
  if (!row || row.revision !== d.revision) {
    throw new Error(`workflows: ${d.flow} moved under the project's workflow lock`);
  }
  let revision = step.approves;
  let designIssueId = input.pending?.designIssueId ?? null;
  if (step.write) {
    const next = await replaceWorkflow(tx, {
      id: d.id,
      revision: row.revision,
      doc: step.write,
      userId: actor.userId,
      design: {
        designFingerprint: designFingerprint(step.write, d.template),
        approvedRevision: row.approvedRevision,
      },
    });
    revision = next.revision;
    // a re-pin is drawn under no issue: the walk for the next proposal's issue passes over it
    designIssueId = null;
    if (row.designStatus !== 'proposed') {
      await moveDesign(tx, d.id, row.designStatus, 'proposed', { writer: actor, reason });
    }
    await insertDesign(tx, {
      workflowId: d.id,
      revision,
      document: step.write,
      userId: actor.userId,
      designIssueId: null,
    });
    if (row.designStatus === 'proposed' && input.pending) {
      await reaskSupersededDesignQuestions(tx, {
        workflowId: d.id,
        superseded: input.pending.revision,
        revision,
        flow: d.flow,
        by: actor.userId,
        actor: { type: 'user', id: actor.userId, agency: actor.agency },
      });
    }
  }
  const approving = step.write ?? readStoredWorkflow(input.pending?.document);
  const unapproved = standingBaseRefusal(revision, approving, await workflowsOf(tx, projectId));
  if (unapproved) throw actRefused([{ ...unapproved, flow: d.flow }]);
  await recordDecision(tx, {
    projectId,
    row: { id: d.id, flow: d.flow, designStatus: 'proposed' },
    designIssueId,
    revision,
    decision: 'approve',
    reason,
    decider: actor,
  });
  return revision;
}

/**
 * The act: every named design re-pinned and approved in one transaction, in the plan's order, or
 * nothing written and each design it cannot take refused by name.
 */
export async function repinAs(input: {
  projectId: string;
  baseId: string;
  actor: WorkflowWriter;
  /** The base's approved revision the plan was read at. */
  revision: number;
  designs: { workflowId: string; revision: number }[];
}): Promise<RepinOutcome> {
  const { projectId, baseId, actor } = input;
  const refusal = await approverRefusalFor(actor, projectId);
  if (refusal) return { ok: false, refusals: [refusal] };
  await assertWriter(actor, projectId);
  const { templates } = await templatesOf(projectId);
  const act = randomUUID();
  try {
    const result = await db.transaction(async (tx): Promise<RepinActResult> => {
      await lockWorkflows(tx, projectId);
      const loaded = await loadDesigns(tx, projectId, templates);
      const base = loaded.designs.find((d) => d.id === baseId);
      if (!base) throw notFound(`project ${projectId} holds no workflow ${baseId}`);
      if (base.approvedRevision === null || base.approvedRevision !== input.revision) {
        throw actRefused([
          {
            code: 'WORKFLOW_DESIGN_REVISION_STALE',
            path: '/revision',
            revision: input.revision,
            detail: `the plan was read with "${base.flow}" approved at revision ${input.revision}, and it stands approved at ${base.approvedRevision === null ? 'no revision' : `revision ${base.approvedRevision}`} now; read the plan again.`,
          },
        ]);
      }
      const include = new Set(input.designs.map((d) => d.workflowId));
      const plan = planRepins(base.flow, loaded.designs, include);
      const refusals = namedRefusals(input.designs, loaded, plan, base.flow);
      if (refusals.length > 0) throw actRefused(refusals);
      const words = `"approve ${plan.ready.length} pin-only ${plan.ready.length === 1 ? 'change' : 'changes'} → r${base.approvedRevision}" on ${base.flow}`;
      const approved: RepinActResult['approved'] = [];
      for (const step of plan.ready) {
        const reason = `Pin-only re-pin, approved together in act ${act} (${words}): ${pinWords(step)}. Nothing else changed: with the pins set aside the design's canonical fingerprint is ${step.change.fingerprint.slice(0, 12)}, as approved r${step.design.approvedRevision} has it.`;
        const pending = loaded.pending.get(step.design.id);
        const revision = await takeStep(tx, {
          projectId,
          step,
          actor,
          reason,
          ...(pending ? { pending } : {}),
        });
        approved.push({
          workflowId: step.design.id,
          flow: step.design.flow,
          revision,
          pins: step.change.pins,
        });
      }
      return {
        act,
        base: { workflowId: base.id, flow: base.flow, approvedRevision: base.approvedRevision },
        approved,
      };
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof RefusalError)
      return { ok: false, refusals: err.refusals as DesignRefusal[] };
    throw err;
  }
}
