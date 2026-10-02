import { lineKindOf, type WorkflowTemplate } from "@forge/contracts/workflow-templates";
import type { WorkflowBody, WorkflowEdgeContract, WorkflowStep } from "./types";

export type StepMark = "added" | "changed" | "removed";

export interface DesignDiff {
  steps: Map<string, StepMark>;
  edges: Map<string, StepMark>;
  removed: WorkflowStep[];
}

export const edgeKey = (from: string, to: string) => `${from}>${to}`;

const designOf = (s: WorkflowStep) =>
  JSON.stringify({ title: s.title ?? null, does: s.does, after: [...s.after].sort(), node: s.node ?? null });

/** The kind a line naming none takes in this design: the one its endpoint types imply. */
function impliedKind(w: WorkflowBody, e: WorkflowEdgeContract, template: WorkflowTemplate | null): string | null {
  if (!template) return null;
  const typeOf = (id: string) => w.steps.find((s) => s.id === id)?.node?.type ?? template.defaultNodeType ?? null;
  const k = lineKindOf(template, typeOf(e.from), typeOf(e.to));
  return "kind" in k ? k.kind : null;
}

const contractOf = (w: WorkflowBody, e: WorkflowEdgeContract | undefined, template: WorkflowTemplate | null) => {
  if (!e) return "null";
  const { kind, ...rest } = e;
  return JSON.stringify(kind === undefined || kind === impliedKind(w, e, template) ? rest : e);
};

/**
 * What the proposed revision changes against the approved one, in the terms its approver decides on;
 * an edge of the kind its endpoints imply compares equal whether or not it spells the kind out.
 */
export function designDiff(approved: WorkflowBody, proposed: WorkflowBody, template: WorkflowTemplate | null = null): DesignDiff {
  const before = new Map(approved.steps.map((s) => [s.id, s]));
  const after = new Map(proposed.steps.map((s) => [s.id, s]));
  const steps = new Map<string, StepMark>();
  for (const s of proposed.steps) {
    const was = before.get(s.id);
    if (!was) steps.set(s.id, "added");
    else if (designOf(was) !== designOf(s)) steps.set(s.id, "changed");
  }
  const removed = approved.steps.filter((s) => !after.has(s.id));
  for (const s of removed) steps.set(s.id, "removed");
  const contracts = (w: WorkflowBody) => new Map((w.edges ?? []).map((e) => [edgeKey(e.from, e.to), e]));
  const oldEdges = contracts(approved);
  const newEdges = contracts(proposed);
  const edges = new Map<string, StepMark>();
  for (const key of new Set([...oldEdges.keys(), ...newEdges.keys()])) {
    const was = oldEdges.get(key);
    const now = newEdges.get(key);
    if (!was) edges.set(key, "added");
    else if (!now) edges.set(key, "removed");
    else if (contractOf(approved, was, template) !== contractOf(proposed, now, template)) edges.set(key, "changed");
  }
  return { steps, edges, removed };
}

/** The steps drawn with the diff on: the proposed ones, and the approved ones it removes, kept in place. */
export function stepsWithRemoved(proposed: WorkflowBody, diff: DesignDiff | null): WorkflowStep[] {
  if (!diff || diff.removed.length === 0) return proposed.steps;
  const ids = new Set([...proposed.steps.map((s) => s.id), ...diff.removed.map((s) => s.id)]);
  return [...proposed.steps, ...diff.removed.map((s) => ({ ...s, after: s.after.filter((a) => ids.has(a)) }))];
}

export function contractText(e: WorkflowEdgeContract): string {
  const lines = [
    e.condition ? `when ${e.condition}` : null,
    e.action ? `do ${e.action}` : null,
    e.mapping && Object.keys(e.mapping).length > 0
      ? `map ${Object.entries(e.mapping)
          .map(([k, v]) => `${k} ← ${v}`)
          .join(", ")}`
      : null,
    e.idempotency ? `once: ${e.idempotency}` : null,
    e.onFailure ? `on failure: ${e.onFailure}` : null,
  ];
  const head = e.kind ? `${e.from} → ${e.to} (${e.kind})` : `${e.from} → ${e.to}`;
  const back = e.reevaluates ? [`re-evaluates ${e.reevaluates}`] : [];
  return [head, ...back, ...lines.filter((l): l is string => l !== null)].join("\n");
}
