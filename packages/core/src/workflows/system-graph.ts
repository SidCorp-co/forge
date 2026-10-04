import {
  type Boundary,
  type BoundarySide,
  type FocalSystem,
  type GraphFacts,
  type GraphNode,
  type IntegrationState,
  type NodeKind,
  type Relationship,
  SYSTEM_CONTEXT_TEMPLATE,
} from '@forge/contracts/system-graph';
import {
  lineKindOf,
  type TemplateEdgeKind,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import type { WorkflowWriteV2 } from './schema.js';

/** What the graph is read from: a version 2 design's steps, lines and lanes. */
export type GraphDoc = Pick<WorkflowWriteV2, 'steps' | 'edges' | 'lanes'>;
type Step = GraphDoc['steps'][number];

export const isSystemContext = (t: WorkflowTemplate | null): t is WorkflowTemplate =>
  t?.id === SYSTEM_CONTEXT_TEMPLATE;

const GENERIC_KIND: TemplateEdgeKind = {
  id: 'flow',
  label: 'Flow',
  tooltip: 'The next step.',
  direction: 'forward',
  required: [],
  line: 'solid',
  colour: 'neutral',
};

// The schema has no field for whether an outside system's integration is settled, so designs say it in
// a closing aside on the label, in the project's own language. Only an aside naming it unconfirmed or
// proposed counts.
const OPEN_MARK =
  /\s*\(([^()]*?(?:chưa xác nhận|đề xuất|unconfirmed|not confirmed|proposed|to be confirmed)[^()]*)\)\s*$/iu; // i18n-allow: the words HOP's designs mark an open integration with

function integrationOf(title: string): {
  name: string;
  state: IntegrationState;
  mark: string | null;
} {
  const m = OPEN_MARK.exec(title);
  if (!m) return { name: title.trim(), state: 'confirmed', mark: null };
  return {
    name: title.slice(0, m.index).trim() || title.trim(),
    state: 'unconfirmed',
    mark: m[1]?.trim() ?? null,
  };
}

/**
 * The design with the steps a compared revision held and this one removed put back, their `after`
 * kept to steps either holds, so a diff can draw what went.
 */
export function withRemoved(doc: GraphDoc, against: GraphDoc): GraphDoc {
  const held = new Set(doc.steps.map((s) => s.id));
  const removed = against.steps.filter((s) => !held.has(s.id));
  if (removed.length === 0) return doc;
  const ids = new Set([...held, ...removed.map((s) => s.id)]);
  return {
    ...doc,
    steps: [
      ...doc.steps,
      ...removed.map((s) => ({ ...s, after: s.after.filter((a) => ids.has(a)) })),
    ],
  };
}

interface Line {
  id: string;
  from: string;
  to: string;
  kind: TemplateEdgeKind;
  contract: NonNullable<GraphDoc['edges']>[number] | null;
}

/** Every line the design draws: an `after` line with its contract, if any, and each return edge. */
function linesOf(
  doc: GraphDoc,
  template: WorkflowTemplate,
  typeOf: (id: string) => string,
): Line[] {
  const steps = new Set(doc.steps.map((s) => s.id));
  const kinds = new Map(template.edgeKinds.map((k) => [k.id, k]));
  const kindOf = (named: string | undefined, from: string, to: string) => {
    const implied = named ? null : lineKindOf(template, typeOf(from), typeOf(to));
    const id = named ?? (implied && 'kind' in implied ? implied.kind : undefined);
    return (id && kinds.get(id)) || GENERIC_KIND;
  };
  const contracts = new Map((doc.edges ?? []).map((e) => [`${e.from}>${e.to}`, e]));
  const out: Line[] = [];
  for (const s of doc.steps) {
    for (const a of s.after) {
      if (!steps.has(a)) continue;
      const contract = contracts.get(`${a}>${s.id}`) ?? null;
      out.push({
        id: `${a}>${s.id}`,
        from: a,
        to: s.id,
        kind: kindOf(contract?.kind, a, s.id),
        contract,
      });
    }
  }
  for (const e of doc.edges ?? []) {
    const kind = kindOf(e.kind, e.from, e.to);
    if (kind.direction !== 'return' || !steps.has(e.from) || !steps.has(e.to)) continue;
    out.push({ id: `${e.from}>${e.to}`, from: e.from, to: e.to, kind, contract: e });
  }
  return out;
}

type C4Type = 'person' | 'system' | 'container';

interface Element {
  id: string;
  type: C4Type;
  title: string;
  lane: string | null;
}

const titleOf = (s: Step) => s.node?.label ?? s.title ?? s.id;
const purposeOf = (s: Step) => s.node?.purpose ?? s.does;

/**
 * The system in scope is the boundary that holds the containers (C4: containers only ever live inside
 * the system being described). A design with no container has no boundary to read, so its most
 * connected system stands alone as the one in scope.
 */
function focalOf(
  els: Element[],
  doc: GraphDoc,
  step: ReadonlyMap<string, Step>,
  lines: Line[],
): FocalSystem | null {
  const stated = (id: string | undefined) =>
    id ? (step.get(id)?.node?.purpose?.trim() ?? '') : '';
  const does = (id: string | undefined) => {
    const s = id ? step.get(id) : undefined;
    return s ? purposeOf(s) : '';
  };
  const containers = els.filter((e) => e.type === 'container');
  if (containers.length > 0) {
    const count = new Map<string | null, number>();
    for (const e of containers) count.set(e.lane, (count.get(e.lane) ?? 0) + 1);
    const lane = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const parts = els.filter(
      (e) =>
        e.type !== 'person' && (e.lane === lane || (e.type === 'container' && e.lane === null)),
    );
    const named = (doc.lanes ?? []).find((l) => l.id === lane);
    const system = parts.find((p) => p.type === 'system');
    return {
      boundary: lane,
      title: named?.label ?? system?.title ?? 'This system',
      tip: named?.tooltip ?? does(system?.id),
      purpose: stated(system?.id),
      parts: parts.map((p) => p.id),
    };
  }
  const degree = (id: string) => lines.filter((e) => e.from === id || e.to === id).length;
  const top = els.filter((e) => e.type === 'system').sort((a, b) => degree(b.id) - degree(a.id))[0];
  if (!top) return null;
  return {
    boundary: top.lane,
    title: top.title,
    tip: does(top.id),
    purpose: stated(top.id),
    parts: [top.id],
  };
}

function factsOf(nodes: GraphNode[], boundaries: Boundary[]): GraphFacts {
  const node = new Map(nodes.map((n) => [n.id, n]));
  const externals = nodes.filter((n) => n.kind === 'external' && !n.removed);
  const unconfirmed = (ids: string[]) =>
    ids.filter((id) => node.get(id)?.integration === 'unconfirmed').length;
  const outside = boundaries.filter((b) => b.side === 'outside');
  const loose = externals.filter((n) => n.boundary === null).map((n) => n.id);
  const live = (ids: string[]) => ids.filter((id) => !node.get(id)?.removed);
  return {
    people: nodes.filter((n) => n.kind === 'person' && !n.removed).map((n) => ({ name: n.title })),
    externals: externals.length,
    boundaries: [
      ...outside.map((b) => ({
        name: b.label,
        count: live(b.members).length,
        unconfirmed: unconfirmed(live(b.members)),
      })),
      ...(loose.length
        ? [{ name: 'No boundary', count: loose.length, unconfirmed: unconfirmed(loose) }]
        : []),
    ],
    namedBoundaries: outside.length,
  };
}

interface GraphParts {
  focal: FocalSystem | null;
  nodes: GraphNode[];
  relationships: Relationship[];
  boundaries: Boundary[];
  facts: GraphFacts;
}

/**
 * A system-context design read as a C4 graph: its elements, its relationships with their own words
 * and technology, its boundaries and the facts the overview states. `removed` names the steps drawn
 * only to show a diff (`withRemoved`).
 */
export function systemGraphOf(
  doc: GraphDoc,
  template: WorkflowTemplate,
  removed: ReadonlySet<string> = new Set(),
): GraphParts {
  const step = new Map(doc.steps.map((s) => [s.id, s]));
  const typeOf = (id: string) => step.get(id)?.node?.type ?? template.defaultNodeType ?? 'STEP';
  const c4TypeOf = (id: string): C4Type => {
    const t = typeOf(id);
    return t === 'PERSON' ? 'person' : t === 'CONTAINER' ? 'container' : 'system';
  };
  const lines = linesOf(doc, template, typeOf);
  const els: Element[] = doc.steps.map((s) => ({
    id: s.id,
    type: c4TypeOf(s.id),
    title: titleOf(s),
    lane: s.node?.band ?? null,
  }));
  const focal = focalOf(els, doc, step, lines);
  const inside = new Set(focal?.parts ?? []);
  const nodes: GraphNode[] = els.map((e) => {
    const s = step.get(e.id);
    const kind: NodeKind = e.type === 'person' ? 'person' : inside.has(e.id) ? e.type : 'external';
    const said = kind === 'external' ? integrationOf(e.title) : null;
    return {
      id: e.id,
      kind,
      title: e.title,
      name: said?.name ?? e.title,
      purpose: s ? purposeOf(s) : '',
      owner: s?.node?.owner ?? null,
      boundary: e.lane,
      integration: said?.state ?? null,
      mark: said?.mark ?? null,
      removed: removed.has(e.id),
    };
  });
  const sideOf = (n: GraphNode): BoundarySide =>
    n.kind === 'person' ? 'people' : n.kind === 'external' ? 'outside' : 'focal';
  const boundaries: Boundary[] = [];
  for (const lane of doc.lanes ?? []) {
    for (const side of ['people', 'focal', 'outside'] as const) {
      const members = nodes
        .filter((n) => n.boundary === lane.id && sideOf(n) === side)
        .map((n) => n.id);
      if (members.length) {
        boundaries.push({
          id: `${side}:${lane.id}`,
          lane: lane.id,
          side,
          label: lane.label,
          tip: lane.tooltip ?? '',
          members,
        });
      }
    }
  }
  const relationships: Relationship[] = lines.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: e.contract?.label ?? e.contract?.condition ?? e.kind.label,
    technology: e.contract?.protocol ?? null,
    kind: e.kind,
  }));
  return { focal, nodes, relationships, boundaries, facts: factsOf(nodes, boundaries) };
}
