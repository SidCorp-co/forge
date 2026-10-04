import { pickFields } from '@forge/contracts/projection';
import {
  DESIGN_HEAD_FIELDS,
  type DesignRevisionSummary,
  type DesignStepsView,
  type DesignSummaryView,
  type WorkflowSummaryView,
} from '@forge/contracts/workflows';
import { HTTPException } from 'hono/http-exception';
import type { DesignView } from './design-service.js';
import type { workflowView } from './service.js';

type WorkflowView = ReturnType<typeof workflowView>;

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

export function workflowSummaryOf(view: WorkflowView): WorkflowSummaryView {
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
    decidedByName: r.decidedByName,
    decidedAt: r.decidedAt,
    reason: r.reason,
    state: r.state,
    stepCount: listIn(r.document, 'steps').length,
  };
}

export function designSummaryOf(design: DesignView): DesignSummaryView {
  return {
    ...pickFields(design, DESIGN_HEAD_FIELDS),
    revisions: design.revisions.map(revisionSummaryOf),
    builds: design.builds,
  };
}

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

export function designStepsOf(
  design: DesignView,
  range: { revision?: number | undefined; from?: number | undefined; to?: number | undefined },
): DesignStepsView {
  const held = design.revisions.map((r) => r.revision);
  const wanted = range.revision ?? held[0];
  const chosen = design.revisions.find((r) => r.revision === wanted);
  if (!chosen) {
    throw badRequest(
      held.length === 0
        ? `design view steps: workflow ${design.workflowId} has no proposed revision yet; read its current document with get`
        : `design view steps: workflow ${design.workflowId} proposed no revision ${wanted}; its revisions are ${held.join(', ')}`,
    );
  }
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
