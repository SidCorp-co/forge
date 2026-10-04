import type { DesignStatus } from '@forge/contracts/design-status';
import { jsonPointer as pointer } from '../lib/refusal.js';
import type { DesignRefusal } from './design.js';
import type { WorkflowRefusal } from './rules.js';
import { readStoredWorkflow, type WorkflowWrite } from './schema.js';
import type { StoredWorkflow } from './store.js';

interface DesignBase {
  readonly workflow: string;
  readonly revision: number;
}

interface BaseReading extends DesignBase {
  readonly designStatus: DesignStatus | null | 'missing';
  readonly approvedRevision: number | null;
}

function basesOf(doc: WorkflowWrite | null): readonly DesignBase[] {
  return doc?.basedOn ?? [];
}

export const basesOfStored = (raw: unknown): readonly DesignBase[] =>
  basesOf(readStoredWorkflow(raw));

// A declared base is a design of the same project at a revision it holds, never itself
// and never twice; a base naming anything else is refused by name at write, never dropped (FB-51)
export function baseRefusals(
  doc: WorkflowWrite,
  held: readonly Pick<StoredWorkflow, 'flow' | 'revision'>[],
): WorkflowRefusal[] {
  const revisions = new Map(
    held.filter((w) => w.flow !== doc.flow).map((w) => [w.flow, w.revision]),
  );
  const seen = new Set<string>();
  const out: WorkflowRefusal[] = [];
  basesOf(doc).forEach((base, i) => {
    const path = pointer(['basedOn', i]);
    if (base.workflow === doc.flow) {
      out.push({
        code: 'WORKFLOW_BASE_SELF',
        path,
        detail: `basedOn names "${base.workflow}", this design itself; a base is another design of the project this one builds on.`,
      });
      return;
    }
    if (seen.has(base.workflow)) {
      out.push({
        code: 'WORKFLOW_BASE_DUPLICATE',
        path,
        detail: `basedOn names "${base.workflow}" twice; name each base once, at the revision this design builds on.`,
      });
      return;
    }
    seen.add(base.workflow);
    const at = revisions.get(base.workflow);
    if (at === undefined) {
      out.push({
        code: 'WORKFLOW_BASE_UNKNOWN',
        path,
        detail: `basedOn names "${base.workflow}", and this project holds no workflow by that flow (its workflows: ${[...revisions.keys()].join(', ') || 'none'}).`,
      });
      return;
    }
    if (base.revision > at) {
      out.push({
        code: 'WORKFLOW_BASE_UNKNOWN',
        path,
        detail: `basedOn names "${base.workflow}" rev ${base.revision}, and that workflow stands at revision ${at}; name a revision it holds.`,
      });
    }
  });
  return out;
}

export function readBases(
  bases: readonly DesignBase[],
  held: readonly Pick<StoredWorkflow, 'flow' | 'designStatus' | 'approvedRevision'>[],
): BaseReading[] {
  const byFlow = new Map(held.map((w) => [w.flow, w]));
  return bases.map((base) => {
    const row = byFlow.get(base.workflow);
    return {
      ...base,
      designStatus: row ? row.designStatus : 'missing',
      approvedRevision: row?.approvedRevision ?? null,
    };
  });
}

function stateOf(b: BaseReading): string {
  if (b.designStatus === 'missing') return 'is no workflow of this project';
  const approved =
    b.approvedRevision === null
      ? 'no approved revision'
      : `approved revision ${b.approvedRevision}`;
  return `is ${b.designStatus ?? 'not in a design lifecycle'}, with ${approved}`;
}

// A design is approved only while every base it declares stands approved at the revision
// it names: a base returned, proposed, never approved or approved at another revision refuses the
// approval by name, each base with its state; returning a design reads no base (FB-51)
export function baseApprovalRefusal(
  revision: number,
  readings: readonly BaseReading[],
): DesignRefusal | null {
  const unapproved = readings.filter((b) => b.approvedRevision !== b.revision);
  if (unapproved.length === 0) return null;
  return {
    code: 'WORKFLOW_DESIGN_BASE_UNAPPROVED',
    path: '/revision',
    detail: `revision ${revision} builds on ${unapproved
      .map((b) => `"${b.workflow}" rev ${b.revision}, which ${stateOf(b)}`)
      .join(
        '; ',
      )}. A design is approved only once every base it declares is approved at the revision it names: approve the base first, or write this design again naming the base revision that is approved.`,
  };
}
