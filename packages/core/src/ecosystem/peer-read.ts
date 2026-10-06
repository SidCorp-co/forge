import { db } from '../db/client.js';
import { loadGraph } from './graph.js';
import { loadInterface } from './interface-service.js';
import { visibleMembers } from './party.js';
import { projectsWhere, recordedVersions } from './store.js';

export interface PeerPublication {
  contract: string;
  slug: string;
  title: string;
  type: string;
  current: string | null;
}

export interface Peer {
  project: { id: string; slug: string; name: string };
  publishes: PeerPublication[];
}

// what a project reads of the ecosystems it is active in, as itself and never as its person's other projects: the peers the ecosystem's visibility shows it, every member that publishes a contract there, and those contracts at their current approved version
export async function ecosystemPeers(
  projectId: string,
  ecosystemIds: readonly string[],
): Promise<Map<string, Peer[]>> {
  const graph = await loadGraph(ecosystemIds);
  const self = new Set([projectId]);
  const mine = ecosystemIds.filter((e) => graph.active.get(e)?.has(projectId));
  const ids = [
    ...new Set(
      mine.flatMap((e) => [...(graph.active.get(e) ?? [])].filter((p) => p !== projectId)),
    ),
  ];
  const [projects, interfaces, versions] = await Promise.all([
    projectsWhere(db, { ids }),
    Promise.all(ids.map(async (id) => [id, await loadInterface(id)] as const)),
    recordedVersions(db, ids),
  ]);
  const named = new Map(projects.map((p) => [p.id, { id: p.id, slug: p.slug, name: p.name }]));
  const held = new Map(interfaces);
  const current = new Map<string, string>();
  for (const v of versions) {
    if (v.approval === 'approved')
      current.set(`${v.providerProjectId}/${v.contractSlug}`, v.version);
  }
  const out = new Map<string, Peer[]>(ecosystemIds.map((e) => [e, []]));
  for (const ecosystemId of mine) {
    const seen = visibleMembers(graph, self, ecosystemId);
    for (const member of graph.active.get(ecosystemId) ?? []) {
      const project = named.get(member);
      if (member === projectId || !project) continue;
      const publishes = Object.entries(held.get(member)?.document.publishes ?? {})
        .filter(([, p]) => p.ecosystems.includes(ecosystemId))
        .map(([slug, p]) => ({
          contract: `${project.slug}/${slug}`,
          slug,
          title: p.title,
          type: p.type,
          current: current.get(`${member}/${slug}`) ?? null,
        }));
      if (seen.has(member) || publishes.length > 0)
        out.get(ecosystemId)?.push({ project, publishes });
    }
  }
  return out;
}
