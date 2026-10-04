import type {
  ContractDirection,
  ContractProjectRef,
  ContractStandingDetail,
  ContractStandingList,
  ContractStandingRow,
} from '@forge/contracts/contract-standing';
import { db } from '../../db/client.js';
import { notFound } from '../../middleware/route-errors.js';
import { loadGraph } from '../graph.js';
import { type HeldInterface, loadInterface } from '../interface-service.js';
import { edgeVisible, liveEdges, type PartyGraph } from '../party.js';
import { activeEcosystemIdsOf, type EdgeRow, projectsWhere } from '../store.js';
import {
  type ChangeRow,
  changeItems,
  OPEN_CHANGE,
  refOf,
  type VersionRow,
  versionFacts,
  viewerOf,
  windowDues,
} from './facts-read.js';
import {
  type ConsumerFact,
  type ContractFacts,
  type Standing,
  type StandingViewer,
  standingOf,
  versionRef,
} from './standing.js';

const MODULE_UNAVAILABLE =
  'The interface document names no module for a publication, so nothing records which module provides or consumes it.';

interface World {
  project: ContractProjectRef;
  held: HeldInterface | null;
  graph: PartyGraph;
  edges: EdgeRow[];
  named: Map<string, ContractProjectRef>;
  interfaces: Map<string, HeldInterface | null>;
  versions: Map<string, VersionRow[]>;
  dues: Map<string, Date>;
  changes: ChangeRow[];
  viewer: StandingViewer;
  now: Date;
}

interface Entry {
  providerId: string;
  slug: string;
  direction: ContractDirection;
}

async function worldOf(projectId: string, userId: string | null, now: Date): Promise<World> {
  const [[self], held, memberships, changes, viewer, dues] = await Promise.all([
    projectsWhere(db, { ids: [projectId] }),
    loadInterface(projectId),
    activeEcosystemIdsOf(db, [projectId]),
    changeItems(projectId),
    viewerOf(projectId, userId),
    windowDues(projectId),
  ]);
  if (!self) throw notFound(`project ${projectId} does not exist`);
  const graph = await loadGraph(memberships.map((m) => m.ecosystemId));
  const edges = liveEdges(graph);
  const providers = new Set<string>([
    ...edges.filter((e) => e.consumerProjectId === projectId).map((e) => e.providerProjectId),
    ...changes.map((c) => c.providerId),
  ]);
  providers.delete(projectId);
  const touching = edges.filter(
    (e) => e.providerProjectId === projectId || providers.has(e.providerProjectId),
  );
  const ids = new Set([
    ...providers,
    ...touching.flatMap((e) => [e.consumerProjectId, e.providerProjectId]),
  ]);
  const [rows, interfaces, versions] = await Promise.all([
    projectsWhere(db, { ids: [...ids] }),
    Promise.all([...providers].map(async (id) => [id, await loadInterface(id)] as const)),
    versionFacts([projectId, ...providers]),
  ]);
  const named = new Map<string, ContractProjectRef>(
    rows.map((p) => [p.id, { id: p.id, slug: p.slug, name: p.name }]),
  );
  named.set(self.id, { id: self.id, slug: self.slug, name: self.name });
  return {
    project: { id: self.id, slug: self.slug, name: self.name },
    held,
    graph,
    edges,
    named,
    interfaces: new Map(interfaces),
    versions,
    dues,
    changes,
    viewer,
    now,
  };
}

function entriesOf(w: World): Entry[] {
  const own = w.project.id;
  const provided = Object.keys(w.held?.document.publishes ?? {}).map(
    (slug): Entry => ({ providerId: own, slug, direction: 'provided' }),
  );
  const consumed = new Map<string, Entry>();
  const add = (providerId: string, slug: string) => {
    if (providerId === own) return;
    const key = `${providerId}/${slug}`;
    if (!consumed.has(key)) consumed.set(key, { providerId, slug, direction: 'consumed' });
  };
  for (const e of w.edges)
    if (e.consumerProjectId === own) add(e.providerProjectId, e.contractSlug);
  for (const c of w.changes) add(c.providerId, c.slug);
  const byRef = (a: Entry, b: Entry) => refKey(w, a).localeCompare(refKey(w, b));
  return [...provided.sort(byRef), ...[...consumed.values()].sort(byRef)];
}

const refKey = (w: World, e: Entry) =>
  refOf(w.named.get(e.providerId)?.slug ?? e.providerId, e.slug);

function consumersOf(w: World, e: Entry): ConsumerFact[] {
  const reader = new Set([w.project.id]);
  const seen = new Map<string, ConsumerFact>();
  for (const x of w.edges) {
    if (x.providerProjectId !== e.providerId || x.contractSlug !== e.slug) continue;
    if (e.direction === 'consumed' && !edgeVisible(w.graph, x, reader)) continue;
    const project = w.named.get(x.consumerProjectId);
    if (project && !seen.has(project.id))
      seen.set(project.id, { project, builtAgainst: x.builtAgainst });
  }
  return [...seen.values()];
}

function changesOn(w: World, e: Entry): ChangeRow[] {
  return w.changes.filter((c) => c.providerId === e.providerId && c.slug === e.slug);
}

interface Read {
  entry: Entry;
  row: ContractStandingRow;
  standing: Standing;
  versions: VersionRow[];
  consumers: ConsumerFact[];
}

function readOf(w: World, e: Entry): Read {
  const provider = w.named.get(e.providerId) ?? {
    id: e.providerId,
    slug: e.providerId,
    name: e.providerId,
  };
  const ref = refOf(provider.slug, e.slug);
  const doc = e.direction === 'provided' ? w.held : (w.interfaces.get(e.providerId) ?? null);
  const publication = doc?.document.publishes[e.slug] ?? null;
  const all = w.versions.get(`${e.providerId}/${e.slug}`) ?? [];
  const versions = e.direction === 'provided' ? all : all.filter((v) => v.approval === 'approved');
  const consumers = consumersOf(w, e);
  const items = changesOn(w, e).filter((c) => c.dueAt !== null);
  const change = items.find((c) => OPEN_CHANGE.includes(c.status)) ?? items[0] ?? null;
  const dues = new Map<string, Date>();
  for (const [k, d] of w.dues)
    if (k.startsWith(`${e.slug}@`)) dues.set(k.slice(e.slug.length + 1), d);
  const ours = w.edges.find(
    (x) =>
      x.consumerProjectId === w.project.id &&
      x.providerProjectId === e.providerId &&
      x.contractSlug === e.slug,
  );
  const facts: ContractFacts = {
    direction: e.direction,
    providerSlug: provider.slug,
    lifecycle: publication?.lifecycle ?? 'production',
    versions,
    ours: ours?.builtAgainst ?? null,
    windowDues: e.direction === 'provided' ? dues : new Map(),
    change: change?.dueAt
      ? {
          feedback: change.key,
          version: change.version,
          dueAt: change.dueAt,
          open: OPEN_CHANGE.includes(change.status),
        }
      : null,
    consumers,
  };
  const s = standingOf(facts, w.viewer, w.now);
  const row: ContractStandingRow = {
    ref,
    slug: e.slug,
    provider,
    direction: e.direction,
    title: publication?.title ?? e.slug,
    summary: publication?.summary ?? null,
    kind: publication?.type ?? 'opaque',
    lifecycle: facts.lifecycle,
    current: s.current ? versionRef(s.current) : null,
    pending: s.pending ? versionRef(s.pending) : null,
    ours: s.ours,
    window: s.window,
    noticeDays: doc?.document.commitments.deprecationNoticeDays ?? null,
    consumers: {
      total: consumers.length,
      current: s.adoption.filter((a) => a === 'current').length,
      behind: s.adoption.filter((a) => a !== 'current').length,
    },
    state: s.state,
    attentionGroup: s.attentionGroup,
    waitingOn: s.waitingOn,
    touchedAt: all[0]?.recordedAt.toISOString() ?? null,
  };
  return { entry: e, row, standing: s, versions, consumers };
}

export async function readContractStanding(
  projectId: string,
  userId: string | null,
  now: Date = new Date(),
): Promise<ContractStandingList> {
  const w = await worldOf(projectId, userId, now);
  return {
    generatedAt: now.toISOString(),
    project: w.project,
    declared: w.held !== null,
    contracts: entriesOf(w).map((e) => readOf(w, e).row),
  };
}

export async function readContractDetail(
  projectId: string,
  userId: string | null,
  ref: { provider: string; contract: string },
  now: Date = new Date(),
): Promise<ContractStandingDetail> {
  const w = await worldOf(projectId, userId, now);
  const entry = entriesOf(w).find((e) => refKey(w, e) === refOf(ref.provider, ref.contract));
  if (!entry) {
    throw notFound(
      `project ${w.project.slug} neither provides nor consumes ${refOf(ref.provider, ref.contract)}`,
    );
  }
  const r = readOf(w, entry);
  return {
    generatedAt: now.toISOString(),
    project: w.project,
    contract: r.row,
    versions: r.versions.map((v) => ({
      ...versionRef(v),
      previous: v.previous,
      changes: v.changes,
      decisionReason: v.decisionReason,
    })),
    consumers: r.consumers.map((c, i) => ({
      project: c.project,
      builtAgainst: c.builtAgainst,
      adoption: r.standing.adoption[i] ?? 'unpublished',
      self: c.project.id === projectId,
    })),
    feedback: changesOn(w, entry).map((c) => ({
      key: c.key,
      title: c.title,
      status: c.status,
      version: c.version,
      dueAt: c.dueAt?.toISOString() ?? null,
    })),
    module: { available: false, reason: MODULE_UNAVAILABLE },
  };
}
