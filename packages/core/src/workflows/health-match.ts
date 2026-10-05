/**
 * The one comparison of the two layers (workflow-step-health `bkm-match`): each observed step and
 * edge paired with the planned one it names, and how a pair differs, aspect by aspect. Core never
 * guesses a pair: an observed step pairs only through its own `matches`.
 */

import type { MarkerAspect } from '@forge/contracts/workflow-health';
import { edgeKey } from './design-diff.js';
import type { ObservationDocument } from './observation-schema.js';
import type { WorkflowWrite } from './schema.js';

type ObservedStep = ObservationDocument['steps'][number];
type PlannedStep = WorkflowWrite['steps'][number];

export interface StepPair {
  observed: string;
  aspects: MarkerAspect[];
}

export interface LayerMatch {
  /** Planned step id → its observed counterpart. */
  steps: Map<string, StepPair>;
  plannedOnlySteps: string[];
  observedOnlySteps: string[];
  /** Planned edge key → the aspects its observed counterpart differs in. */
  edges: Map<string, MarkerAspect[]>;
  plannedOnlyEdges: { from: string; to: string; label: string | null }[];
  /** Observed edges, by observed step ids, whose ends do not name a planned edge. */
  observedOnlyEdges: { from: string; to: string; label: string | null }[];
}

const words = (s: string | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const set = (xs: readonly string[] | undefined) => [...new Set((xs ?? []).map(words))].sort();
const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  JSON.stringify(set(a)) === JSON.stringify(set(b));

const rowsOf = (n: PlannedStep['node'] | ObservedStep['node']) =>
  (n?.conditions ?? []).map((r) => `${words(r.when)}=>${words(r.result)}`).sort();

function behaviourDiffers(p: PlannedStep, o: ObservedStep): boolean {
  return (
    words(p.does) !== words(o.does) ||
    JSON.stringify(rowsOf(p.node)) !== JSON.stringify(rowsOf(o.node))
  );
}

function dataDiffers(p: PlannedStep, o: ObservedStep): boolean {
  return (
    !sameList(p.node?.inputs, o.node?.inputs) ||
    !sameList(p.node?.outputs, o.node?.outputs) ||
    !sameList(p.node?.payload, o.node?.payload)
  );
}

/** Every line of a document by from>to: its edges and the lines its steps' `after` draw. */
function linesOf(
  steps: readonly { id: string; after: readonly string[] }[],
  edges: readonly { from: string; to: string }[],
) {
  const keys = new Set(edges.map((e) => edgeKey(e.from, e.to)));
  for (const s of steps) for (const a of s.after) keys.add(edgeKey(a, s.id));
  return keys;
}

const touching = (lines: ReadonlySet<string>, id: string) =>
  [...lines].filter((k) => k.startsWith(`${id}>`) || k.endsWith(`>${id}`)).sort();

export function matchLayers(planned: WorkflowWrite, observed: ObservationDocument): LayerMatch {
  const plannedById = new Map(planned.steps.map((s) => [s.id, s]));
  const toPlanned = new Map<string, string>();
  for (const o of observed.steps)
    if (o.matches && plannedById.has(o.matches)) toPlanned.set(o.id, o.matches);
  const mapId = (id: string) => toPlanned.get(id) ?? `observed:${id}`;

  const plannedLines = linesOf(planned.steps, planned.edges ?? []);
  const observedLines = new Set(
    [...linesOf(observed.steps, observed.edges)].map((k) => {
      const [from, to] = k.split('>') as [string, string];
      return edgeKey(mapId(from), mapId(to));
    }),
  );

  const steps = new Map<string, StepPair>();
  const observedOnlySteps: string[] = [];
  for (const o of observed.steps) {
    const p = o.matches ? plannedById.get(o.matches) : undefined;
    if (!p) {
      observedOnlySteps.push(o.id);
      continue;
    }
    const aspects: MarkerAspect[] = [];
    if (behaviourDiffers(p, o)) aspects.push('behaviour');
    if (dataDiffers(p, o)) aspects.push('data');
    if (
      JSON.stringify(touching(plannedLines, p.id)) !== JSON.stringify(touching(observedLines, p.id))
    ) {
      aspects.push('wiring');
    }
    steps.set(p.id, { observed: o.id, aspects });
  }
  const plannedOnlySteps = planned.steps.filter((s) => !steps.has(s.id)).map((s) => s.id);

  const observedEdges = new Map(
    observed.edges.map((e) => [edgeKey(mapId(e.from), mapId(e.to)), e] as const),
  );
  const edges = new Map<string, MarkerAspect[]>();
  const plannedOnlyEdges: LayerMatch['plannedOnlyEdges'] = [];
  for (const e of planned.edges ?? []) {
    const key = edgeKey(e.from, e.to);
    const o = observedEdges.get(key);
    if (!o) {
      plannedOnlyEdges.push({ from: e.from, to: e.to, label: e.label ?? null });
      continue;
    }
    edges.set(key, sameList(e.payload, o.payload) ? [] : ['data']);
  }
  const plannedKeys = new Set((planned.edges ?? []).map((e) => edgeKey(e.from, e.to)));
  const observedOnlyEdges = observed.edges
    .filter((e) => !plannedKeys.has(edgeKey(mapId(e.from), mapId(e.to))))
    .map((e) => ({ from: e.from, to: e.to, label: e.label ?? null }));
  return { steps, plannedOnlySteps, observedOnlySteps, edges, plannedOnlyEdges, observedOnlyEdges };
}
