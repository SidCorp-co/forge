import { db } from '../db/client.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import { forbidden, notFound, readerProjects } from './access.js';
import { heldEcosystem } from './ecosystem-service.js';
import { loadGraph } from './graph.js';
import { loadInterface } from './interface-service.js';
import { edgeVisible, liveEdges, type Sight, sightOf } from './party.js';
import type { InterfaceDocument, Publication } from './schema.js';
import {
  activeEcosystemIdsOf,
  type EdgeRow,
  type ProjectRow,
  projectsWhere,
  readEcosystems,
  recordedVersions,
} from './store.js';

const artifactKind = (p: Publication) =>
  p.artifact === null ? 'none' : 'path' in p.artifact ? 'repository' : 'upload';

function publicationsOf(
  target: ProjectRow,
  doc: InterfaceDocument,
  visible: ReadonlySet<string>,
  full: boolean,
  versions: ReadonlyMap<string, string[]>,
  consumers: (slug: string, ecosystems: readonly string[]) => object[],
) {
  return Object.entries(doc.publishes).flatMap(([slug, p]) => {
    const ecosystems = full ? p.ecosystems : p.ecosystems.filter((e) => visible.has(e));
    if (ecosystems.length === 0) return [];
    return [
      {
        contract: `${target.slug}/${slug}`,
        slug,
        title: p.title,
        ...(p.summary ? { summary: p.summary } : {}),
        type: p.type,
        artifact: artifactKind(p),
        lifecycle: p.lifecycle,
        ecosystems,
        versions: versions.get(slug) ?? [],
        consumers: consumers(slug, ecosystems),
      },
    ];
  });
}

function readerOf(full: boolean, sight: ReadonlyMap<string, Sight>) {
  if (full) return { access: 'project' as const };
  return {
    access: 'party' as const,
    via: [...sight.values()].map((s) => ({
      ecosystem: s.ecosystemId,
      visibility: s.mode,
      projects: s.via,
    })),
  };
}

export async function readApiPage(userId: string, projectId: string) {
  const [target] = await projectsWhere(db, { ids: [projectId] });
  if (!target) throw notFound(`project ${projectId} does not exist`);
  const access = await effectiveProjectRole(userId, projectId);
  const full = projectRoleAtLeast(access?.role ?? null, 'viewer');
  const targetEcos = (await activeEcosystemIdsOf(db, [projectId])).map((m) => m.ecosystemId);
  const graph = await loadGraph(targetEcos);
  const reader = full ? new Set([projectId]) : await readerProjects(userId);
  const sight = full ? new Map<string, Sight>() : sightOf(graph, reader, projectId);
  if (!full && sight.size === 0) {
    throw forbidden(
      `project ${projectId} is readable here only by its members and by the projects it publishes to or consumes from in an ecosystem`,
    );
  }
  const visible = new Set(full ? targetEcos : sight.keys());
  const edges = liveEdges(graph).filter(
    (e: EdgeRow) =>
      (e.providerProjectId === projectId || e.consumerProjectId === projectId) &&
      visible.has(e.ecosystemId) &&
      (full || edgeVisible(graph, e, reader)),
  );
  const [held, versionRows, ecos, others] = await Promise.all([
    loadInterface(projectId),
    recordedVersions(db, [projectId]),
    readEcosystems(db, [...visible]),
    projectsWhere(db, {
      ids: [...new Set(edges.flatMap((e) => [e.consumerProjectId, e.providerProjectId]))],
    }),
  ]);
  const named = new Map(others.map((p) => [p.id, { id: p.id, slug: p.slug, name: p.name }]));
  const versions = new Map<string, string[]>();
  for (const v of versionRows)
    versions.set(v.contractSlug, [...(versions.get(v.contractSlug) ?? []), v.version]);
  const consumers = (slug: string, ecosystems: readonly string[]) =>
    edges
      .filter(
        (e) =>
          e.providerProjectId === projectId &&
          e.contractSlug === slug &&
          ecosystems.includes(e.ecosystemId),
      )
      .map((e) => ({
        project: named.get(e.consumerProjectId),
        ecosystem: e.ecosystemId,
        builtAgainst: e.builtAgainst,
      }));
  return {
    project: { id: target.id, slug: target.slug, name: target.name },
    reader: readerOf(full, sight),
    declared: held !== null,
    ecosystems: ecos.map((e) => {
      const d = heldEcosystem(e).document;
      return {
        id: e.id,
        slug: d.ecosystem.slug,
        name: d.ecosystem.name,
        visibility: d.visibility.members,
      };
    }),
    publishes: held
      ? publicationsOf(target, held.document, visible, full, versions, consumers)
      : [],
    consumes: edges
      .filter((e) => e.consumerProjectId === projectId)
      .map((e) => ({
        contract: `${named.get(e.providerProjectId)?.slug}/${e.contractSlug}`,
        provider: named.get(e.providerProjectId),
        ecosystem: e.ecosystemId,
        builtAgainst: e.builtAgainst,
      })),
    commitments: held?.document.commitments ?? null,
  };
}
