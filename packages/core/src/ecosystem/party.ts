import type { VisibilityMode } from './schema.js';
import type { EdgeRow } from './store.js';

export interface PartyGraph {
  active: ReadonlyMap<string, ReadonlySet<string>>;
  visibility: ReadonlyMap<string, VisibilityMode>;
  edges: readonly EdgeRow[];
}

export interface Sight {
  ecosystemId: string;
  mode: VisibilityMode;
  via: string[];
}

const isActive = (graph: PartyGraph, ecosystemId: string, projectId: string) =>
  graph.active.get(ecosystemId)?.has(projectId) ?? false;

export function liveEdges(graph: PartyGraph): EdgeRow[] {
  return graph.edges.filter(
    (e) =>
      isActive(graph, e.ecosystemId, e.consumerProjectId) &&
      isActive(graph, e.ecosystemId, e.providerProjectId),
  );
}

export function areCounterparties(
  graph: PartyGraph,
  ecosystemId: string,
  a: string,
  b: string,
): boolean {
  return liveEdges(graph).some(
    (e) =>
      e.ecosystemId === ecosystemId &&
      ((e.consumerProjectId === a && e.providerProjectId === b) ||
        (e.consumerProjectId === b && e.providerProjectId === a)),
  );
}

// cm:why the one place a reader who holds no role on a project is let see any of it
export function sightOf(
  graph: PartyGraph,
  readerProjects: ReadonlySet<string>,
  target: string,
): Map<string, Sight> {
  const out = new Map<string, Sight>();
  for (const [ecosystemId, members] of graph.active) {
    if (!members.has(target)) continue;
    const mine = [...readerProjects].filter((p) => p !== target && members.has(p));
    const mode = graph.visibility.get(ecosystemId);
    if (!mode) throw new Error(`ecosystem: no visibility loaded for ecosystem ${ecosystemId}`);
    const via =
      mode === 'all' ? mine : mine.filter((p) => areCounterparties(graph, ecosystemId, p, target));
    if (via.length > 0) out.set(ecosystemId, { ecosystemId, mode, via });
  }
  return out;
}

export function visibleMembers(
  graph: PartyGraph,
  readerProjects: ReadonlySet<string>,
  ecosystemId: string,
): Set<string> {
  const members = graph.active.get(ecosystemId) ?? new Set<string>();
  const mine = [...readerProjects].filter((p) => members.has(p));
  if (mine.length === 0) return new Set();
  if (graph.visibility.get(ecosystemId) === 'all') return new Set(members);
  const seen = new Set(mine);
  for (const other of members) {
    if (mine.some((p) => areCounterparties(graph, ecosystemId, p, other))) seen.add(other);
  }
  return seen;
}

export function edgeVisible(
  graph: PartyGraph,
  edge: EdgeRow,
  readerProjects: ReadonlySet<string>,
): boolean {
  if (readerProjects.has(edge.consumerProjectId) || readerProjects.has(edge.providerProjectId)) {
    return true;
  }
  if (graph.visibility.get(edge.ecosystemId) !== 'all') return false;
  return [...readerProjects].some((p) => isActive(graph, edge.ecosystemId, p));
}
