/**
 * What one design revision changes against another (workflow-step-health `bkm-diff`), step by step
 * and edge by edge, edges keyed `from>to`: the one diff the health markers, the orphaned traces and
 * the canvas read.
 */

import type { DiffMark } from '@forge/contracts/workflow-health';
import { lineKindOf, type WorkflowTemplate } from '@forge/contracts/workflow-templates';
import type { WorkflowEdge, WorkflowStepV2, WorkflowWrite } from './schema.js';

export interface DesignDiff {
  steps: Map<string, DiffMark>;
  edges: Map<string, DiffMark>;
}

export const edgeKey = (from: string, to: string) => `${from}>${to}`;

const designOf = (s: WorkflowStepV2) =>
  JSON.stringify({
    title: s.title ?? null,
    does: s.does,
    after: [...s.after].sort(),
    node: s.node ?? null,
  });

/** The kind a line naming none takes in this design: the one its endpoint types imply. */
function impliedKind(
  w: WorkflowWrite,
  e: WorkflowEdge,
  template: WorkflowTemplate | null,
): string | null {
  if (!template) return null;
  const typeOf = (id: string) =>
    w.steps.find((s) => s.id === id)?.node?.type ?? template.defaultNodeType ?? null;
  const k = lineKindOf(template, typeOf(e.from), typeOf(e.to));
  return 'kind' in k ? k.kind : null;
}

function contractOf(w: WorkflowWrite, e: WorkflowEdge, template: WorkflowTemplate | null) {
  const { kind, ...rest } = e;
  return JSON.stringify(kind === undefined || kind === impliedKind(w, e, template) ? rest : e);
}

const edgesOf = (w: WorkflowWrite) =>
  new Map((w.edges ?? []).map((e) => [edgeKey(e.from, e.to), e]));

/**
 * `after` against `before`: a step id only in `after` is added, in both but differing in title, does,
 * after or node is changed, only in `before` is removed; an edge key only in `before` is removed (a
 * rewire is the old key removed and the new one added), in both with another contract is changed. An
 * edge of the kind its endpoints imply compares equal whether or not it spells the kind out.
 */
export function designDiff(
  before: WorkflowWrite,
  after: WorkflowWrite,
  template: WorkflowTemplate | null = null,
): DesignDiff {
  const was = new Map(before.steps.map((s) => [s.id, s]));
  const now = new Set(after.steps.map((s) => s.id));
  const steps = new Map<string, DiffMark>();
  for (const s of after.steps) {
    const old = was.get(s.id);
    if (!old) steps.set(s.id, 'added');
    else if (designOf(old) !== designOf(s)) steps.set(s.id, 'changed');
  }
  for (const s of before.steps) if (!now.has(s.id)) steps.set(s.id, 'removed');
  const oldEdges = edgesOf(before);
  const newEdges = edgesOf(after);
  const edges = new Map<string, DiffMark>();
  for (const key of new Set([...oldEdges.keys(), ...newEdges.keys()])) {
    const a = oldEdges.get(key);
    const b = newEdges.get(key);
    if (!a) edges.set(key, 'added');
    else if (!b) edges.set(key, 'removed');
    else if (contractOf(before, a, template) !== contractOf(after, b, template)) {
      edges.set(key, 'changed');
    }
  }
  return { steps, edges };
}
