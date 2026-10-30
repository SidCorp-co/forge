import { pickFields } from '@forge/contracts/projection';
import type { WorkflowHealthSummary } from '@forge/contracts/workflow-health';
import {
  DESIGN_HEAD_FIELDS,
  type DESIGN_VIEWS,
  type DesignCurrentSummary,
  type DesignRevisionSummary,
  type DesignStepsView,
  type DesignSummaryView,
  type WorkflowSummaryView,
} from '@forge/contracts/workflows';
import { HTTPException } from 'hono/http-exception';
import type { DesignView } from './design-service.js';
import type { workflowView } from './service.js';

type WorkflowView = ReturnType<typeof workflowView>;
type ListedWorkflow = WorkflowView & { health: WorkflowHealthSummary };

const listIn = (doc: unknown, key: 'steps' | 'edges'): unknown[] => {
  if (doc === null || typeof doc !== 'object') return [];
  const list = (doc as Record<string, unknown>)[key];
  return Array.isArray(list) ? list : [];
};

function templateOf(doc: Record<string, unknown>): WorkflowSummaryView['template'] {
  const t = doc.template as { id?: unknown; version?: unknown } | undefined;
  return typeof t?.id === 'string' && typeof t.version === 'number'
    ? { id: t.id, version: t.version }
    : null;
}

export function workflowSummaryOf(view: ListedWorkflow): WorkflowSummaryView {
  const doc = view.document as unknown as Record<string, unknown>;
  return {
    workflowId: view.document.id,
    flow: view.document.flow,
    title: typeof doc.title === 'string' ? doc.title : view.document.flow,
    kind: typeof doc.kind === 'string' ? doc.kind : null,
    template: templateOf(doc),
    status: view.design.status,
    revision: view.revision,
    approvedRevision: view.design.approvedRevision,
    stepCount: listIn(doc, 'steps').length,
    edgeCount: listIn(doc, 'edges').length,
    returnReason: 'returnReason' in view.design ? (view.design.returnReason ?? null) : null,
    writerName: view.writerName,
    updatedAt: view.document.updatedAt,
    health: view.health,
  };
}

function revisionSummaryOf(r: DesignView['revisions'][number]): DesignRevisionSummary {
  return {
    revision: r.revision,
    designIssueId: r.designIssueId,
    proposedBy: r.proposedBy,
    proposedByName: r.proposedByName,
    proposedAt: r.proposedAt,
    decision: r.decision,
    decidedBy: r.decidedBy,
    decidedKind: r.decidedKind,
    decidedByName: r.decidedByName,
    decidedAt: r.decidedAt,
    reason: r.reason,
    says: r.says,
    state: r.state,
    stepCount: listIn(r.document, 'steps').length,
    changes: r.changes,
  };
}

function currentSummaryOf(current: DesignView['current']): DesignCurrentSummary {
  return {
    revision: current.revision,
    stepCount: listIn(current.document, 'steps').length,
    edgeCount: listIn(current.document, 'edges').length,
    updatedAt: current.updatedAt,
  };
}

function designSummaryOf(design: DesignView): DesignSummaryView {
  return {
    ...pickFields(design, DESIGN_HEAD_FIELDS),
    current: currentSummaryOf(design.current),
    revisions: design.revisions.map(revisionSummaryOf),
    builds: design.builds,
  };
}

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

type StepRange = {
  revision?: number | undefined;
  from?: number | undefined;
  to?: number | undefined;
};

/** The document a steps view reads: a proposed revision by its number, else the current one, which
 *  is also what it reads when none is named, so a draft never proposed reads as REST's GET reads it. */
function documentAt(design: DesignView, wanted: number): { revision: number; document: unknown } {
  const proposed = design.revisions.find((r) => r.revision === wanted);
  if (proposed) return proposed;
  if (wanted === design.current.revision) return design.current;
  const held = design.revisions.map((r) => r.revision);
  throw badRequest(
    `design view steps: workflow ${design.workflowId} holds no revision ${wanted} to read; its current revision ${design.current.revision} reads${
      held.length === 0
        ? ', and it has proposed none'
        : `, and so do its proposed revisions ${held.join(', ')}`
    }`,
  );
}

function designStepsOf(design: DesignView, range: StepRange): DesignStepsView {
  const chosen = documentAt(design, range.revision ?? design.current.revision);
  const steps = listIn(chosen.document, 'steps');
  const from = range.from ?? 1;
  if ((range.to !== undefined && range.to < from) || (from > 1 && from > steps.length)) {
    throw badRequest(
      `design view steps: stepFrom ${from} to stepTo ${range.to ?? steps.length} is not a range of revision ${chosen.revision}, which has ${steps.length} steps numbered from 1`,
    );
  }
  const to = Math.min(range.to ?? steps.length, steps.length);
  const chosenSteps = steps.slice(from - 1, to);
  const ids = new Set(chosenSteps.map((s) => (s as { id?: unknown }).id));
  const edges = listIn(chosen.document, 'edges');
  return {
    ...designSummaryOf(design),
    document: {
      revision: chosen.revision,
      stepCount: steps.length,
      edgeCount: edges.length,
      from,
      to,
      steps: chosenSteps,
      edges: edges.filter((e) => {
        const { from: a, to: b } = e as { from?: unknown; to?: unknown };
        return ids.has(a) || ids.has(b);
      }),
    },
  };
}

/** One design read as either door asks for it; a revision or step range bounds the steps view only. */
export function designReadOf(
  design: DesignView,
  view: (typeof DESIGN_VIEWS)[number],
  range: StepRange,
) {
  if (
    view !== 'steps' &&
    (range.revision !== undefined || range.from !== undefined || range.to !== undefined)
  ) {
    throw badRequest(
      `design view ${view}: revision, stepFrom and stepTo bound view=steps; send view=steps with them`,
    );
  }
  if (view === 'summary') return designSummaryOf(design);
  if (view === 'steps') return designStepsOf(design, range);
  return design;
}
