import {
  CONTRACT_MEASUREMENTS_SHOWN,
  type ContractDirection,
  type ContractProjectRef,
  type ContractRequestRow,
  type ContractStandingDetail,
  type ContractStandingList,
  type ContractStandingRow,
} from '@forge/contracts/contract-standing';
import type { ContractRequestView } from '@forge/contracts/contract-waits';
import { db } from '../../db/client.js';
import { measurementsOf } from '../contract/store.js';
import { loadGraph } from '../graph.js';
import { type HeldInterface, loadInterface } from '../interface-service.js';
import { edgeVisible, liveEdges, type PartyGraph } from '../party.js';
import { listContractRequests } from '../requests/read.js';
import { activeEcosystemIdsOf, type EdgeRow, projectsWhere } from '../store.js';
import {
  type ChangeRow,
  changeItems,
  consumerDemand,
  issueWaits,
  OPEN_CHANGE,
  refOf,
  type VersionRow,
  versionFacts,
  viewerOf,
  type WaitRow,
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

export class ContractNotFoundError extends Error {}

export const MODULE_UNAVAILABLE =
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
  requests: ContractRequestView[];
  waits: WaitRow[];
  viewer: StandingViewer;
  now: Date;
}

interface Entry {
  providerId: string;
  slug: string;
  direction: ContractDirection;
}

const contractSlugOf = (ref: string) => ref.slice(ref.indexOf('/') + 1);

async function worldOf(projectId: string, userId: string | null, now: Date): Promise<World> {
  const [[self], held, memberships, changes, requests, waits, viewer, dues] = await Promise.all([
    projectsWhere(db, { ids: [projectId] }),
    loadInterface(projectId),
    activeEcosystemIdsOf(db, [projectId]),
    changeItems(projectId),
    listContractRequests(projectId),
    issueWaits(projectId),
    viewerOf(projectId, userId),
    windowDues(projectId),
  ]);
  if (!self) throw new ContractNotFoundError(`project ${projectId} does not exist`);
  const graph = await loadGraph(memberships.map((m) => m.ecosystemId));
  const edges = liveEdges(graph);
  const providers = new Set<string>([
    ...edges.filter((e) => e.consumerProjectId === projectId).map((e) => e.providerProjectId),
    ...changes.map((c) => c.providerId),
    ...waits.map((w) => w.providerId),
    ...requests.filter((r) => r.direction === 'outgoing').map((r) => r.provider.id),
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
    requests,
    waits,
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
  for (const x of w.waits) add(x.providerId, x.slug);
  for (const c of w.changes) add(c.providerId, c.slug);
  for (const r of w.requests)
    if (r.direction === 'outgoing') add(r.provider.id, contractSlugOf(r.contract));
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

function requestsOn(w: World, ref: string): ContractRequestRow[] {
  return w.requests
    .filter((r) => r.contract === ref)
    .map((r) => {
      const counterpart = r.direction === 'incoming' ? r.consumer : r.provider;
      return {
        number: r.number,
        direction: r.direction,
        counterpart: w.named.get(counterpart.id) ?? {
          id: counterpart.id,
          slug: counterpart.slug,
          name: counterpart.slug,
        },
        requirement: { ...r.requirement, project: r.provider.slug },
        open: r.requirement.status === 'draft',
        createdAt: r.createdAt,
      };
    });
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
  requests: ContractRequestRow[];
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
  const requests = requestsOn(w, ref);
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
  const open = w.waits.filter(
    (x) => x.providerId === e.providerId && x.slug === e.slug && !x.settled,
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
    requests: requests.map((r) => ({
      number: r.number,
      direction: r.direction,
      counterpart: r.counterpart.slug,
      requirementKey: r.requirement.key,
      open: r.open,
    })),
    waits: open.map((x) => ({ issue: x.issue, minVersion: x.minVersion })),
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
    waits: open.length,
    openRequests: requests.filter((r) => r.open).length,
    state: s.state,
    attentionGroup: s.attentionGroup,
    waitingOn: s.waitingOn,
    touchedAt: all[0]?.recordedAt.toISOString() ?? null,
  };
  return { entry: e, row, standing: s, versions, consumers, requests };
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
    throw new ContractNotFoundError(
      `project ${w.project.slug} neither provides nor consumes ${refOf(ref.provider, ref.contract)}, and none of its issues waits on it`,
    );
  }
  const r = readOf(w, entry);
  const provided = entry.direction === 'provided';
  const consumerIds = new Set(r.consumers.map((c) => c.project.id));
  const [demand, measured] = await Promise.all([
    provided ? consumerDemand(projectId) : Promise.resolve([]),
    provided
      ? measurementsOf(projectId, entry.slug, CONTRACT_MEASUREMENTS_SHOWN)
      : Promise.resolve(null),
  ]);
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
    waits: w.waits
      .filter((x) => x.providerId === entry.providerId && x.slug === entry.slug)
      .map((x) => ({
        issue: x.issue,
        title: x.title,
        status: x.status,
        minVersion: x.minVersion,
        reason: x.reason,
        settled: x.settled,
      })),
    demand: demand
      .filter((d) => d.slug === entry.slug && consumerIds.has(d.consumerId))
      .flatMap((d) => {
        const project = w.named.get(d.consumerId);
        return project ? [{ project, issues: d.issues, minVersions: d.minVersions }] : [];
      }),
    requests: r.requests,
    feedback: changesOn(w, entry).map((c) => ({
      key: c.key,
      title: c.title,
      status: c.status,
      version: c.version,
      dueAt: c.dueAt?.toISOString() ?? null,
    })),
    measurements: measured
      ? measured.map((m) => ({
          outcome: m.outcome,
          version: m.version,
          environments: m.environments,
          branch: m.branch,
          commit: m.commitSha,
          observedAt: m.observedAt.toISOString(),
          reason: m.reason,
        }))
      : null,
    module: { available: false, reason: MODULE_UNAVAILABLE },
  };
}
