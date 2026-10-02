import { fencedProjectIds } from '../auth/pat-scope.js';
import { db } from '../db/client.js';
import { assertProjectAccess, effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import { forbidden, notFound, readerProjects } from './access.js';
import { type LinkImpact, linkImpact } from './contract/impact.js';
import { latestVersion, type StoredVersion, versionsOf } from './contract/store.js';
import { loadGraph } from './graph.js';
import { heldInterface } from './interface-service.js';
import { type Held, impactLink, storedBuilderRun, storedLink } from './link-service.js';
import {
  builderRunsIn,
  builderRunsOf,
  linksWhere,
  readBuilderRun,
  readLink,
  type StoredLink,
  type StoredRecord,
} from './link-store.js';
import { readableEcosystem } from './membership-service.js';
import { edgeVisible, visibleMembers } from './party.js';
import type { EdgeRow } from './store.js';
import { projectsWhere, readInterfaces, recordedVersions } from './store.js';

const stamped = <W extends object>(held: Held<W>) => ({
  ...held.document,
  id: held.row.id,
  createdAt: held.row.createdAt.toISOString(),
  updatedAt: held.row.updatedAt.toISOString(),
});

export function recordView<W extends object>(held: Held<W>) {
  return { revision: held.row.revision, writer: held.row.writtenByUser, document: stamped(held) };
}

const asEdge = (l: StoredLink): EdgeRow => ({
  consumerProjectId: l.projectId,
  providerProjectId: l.providerProjectId,
  contractSlug: l.contractSlug,
  ecosystemId: l.ecosystemId,
  builtAgainst: l.pinnedVersion,
});

// cm:why a link is the consumer's record, read in full by the consumer's members and by the provider it points at; anyone else reads it only where the ecosystem shows every member everything
async function assertLinkReadable(userId: string, link: StoredLink): Promise<void> {
  const role = (await effectiveProjectRole(userId, link.projectId))?.role ?? null;
  if (projectRoleAtLeast(role, 'viewer')) return;
  const graph = await loadGraph([link.ecosystemId]);
  const reader = await readerProjects(userId, fencedProjectIds() ?? undefined);
  if (edgeVisible(graph, asEdge(link), reader)) return;
  throw forbidden(
    `link ${link.id} is readable by project ${link.projectId}'s members, by its provider, and by members of an ecosystem whose members see everything`,
  );
}

export async function readLinkAs(userId: string, projectId: string, linkId: string) {
  const row = await readLink(db, linkId);
  if (!row || row.projectId !== projectId) {
    throw notFound(`project ${projectId} holds no link ${linkId}`);
  }
  await assertLinkReadable(userId, row);
  const current = await latestVersion(db, row.providerProjectId, row.contractSlug);
  return {
    ...recordView({ row, document: storedLink(row) }),
    currentVersion: current?.version ?? null,
  };
}

export async function listLinksAs(userId: string, projectId: string) {
  await assertProjectAccess(projectId, userId, 'viewer');
  const rows = await linksWhere(db, { consumerId: projectId });
  return rows.map((row) => recordView({ row, document: storedLink(row) }));
}

export async function readBuilderRunAs(userId: string, projectId: string, runId: string) {
  await assertProjectAccess(projectId, userId, 'viewer');
  const row = await readBuilderRun(db, runId);
  if (!row || row.projectId !== projectId) {
    throw notFound(`project ${projectId} holds no builder run ${runId}`);
  }
  return recordView({ row, document: storedBuilderRun(row) });
}

export async function listBuilderRunsAs(userId: string, projectId: string) {
  await assertProjectAccess(projectId, userId, 'viewer');
  const rows = await builderRunsOf(db, projectId);
  return rows.map((row) => recordView({ row, document: storedBuilderRun(row) }));
}

// cm:why the bus carries each project's latest builder run as its step states and counts only: the findings and their call sites stay behind the run's own read, which the project's members hold
function latestBuilderRuns(rows: StoredRecord[], shown: ReadonlySet<string>) {
  const latest = new Map<string, ReturnType<typeof builderSummary>>();
  for (const row of rows) {
    if (!shown.has(row.projectId) || latest.has(row.projectId)) continue;
    latest.set(row.projectId, builderSummary(row));
  }
  return latest;
}

function builderSummary(row: StoredRecord) {
  const run = storedBuilderRun(row);
  return {
    id: row.id,
    trigger: run.trigger,
    steps: run.steps,
    findings: run.findings.length,
    links: run.links.length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function currentVersions(rows: Awaited<ReturnType<typeof recordedVersions>>) {
  const latest = new Map<string, string>();
  for (const v of rows) latest.set(`${v.providerProjectId}/${v.contractSlug}`, v.version);
  return latest;
}

// cm:why each link is checked against its contract's latest recorded version, so the bus says which consumers that version breaks and by which fields and call sites
function impactsAgainstLatest(
  links: readonly StoredLink[],
  versions: readonly StoredVersion[],
  versioningOf: (provider: string) => 'dated' | 'semver',
): Map<string, LinkImpact & { version: string }> {
  const latest = new Map<string, StoredVersion>();
  for (const v of versions) {
    const key = `${v.providerProjectId}/${v.contractSlug}`;
    if (!latest.has(key)) latest.set(key, v);
  }
  const out = new Map<string, LinkImpact & { version: string }>();
  for (const l of links) {
    const v = latest.get(`${l.providerProjectId}/${l.contractSlug}`);
    if (!v) continue;
    out.set(l.id, {
      ...linkImpact(versioningOf(l.providerProjectId), v.version, v.document.diff, impactLink(l)),
      version: v.version,
    });
  }
  return out;
}

// cm:why the bus is the ecosystem as the reader may see it: the steward sees every active member, a member sees what its visibility mode shows, and a link shows where its consumer or provider is the reader's or the mode is all
export async function readBus(userId: string, ecosystemId: string) {
  const { eco, steward } = await readableEcosystem(userId, ecosystemId);
  const graph = await loadGraph([ecosystemId]);
  const members = graph.active.get(ecosystemId) ?? new Set<string>();
  const mine = await readerProjects(userId);
  const seen = steward ? new Set(members) : visibleMembers(graph, mine, ecosystemId);
  const links = (await linksWhere(db, { ecosystemIds: [ecosystemId] })).filter(
    (l) =>
      members.has(l.projectId) &&
      members.has(l.providerProjectId) &&
      (steward || edgeVisible(graph, asEdge(l), mine)),
  );
  const shown = [
    ...new Set([...seen, ...links.flatMap((l) => [l.projectId, l.providerProjectId])]),
  ];
  const [projects, interfaces, versions, runs, linked] = await Promise.all([
    projectsWhere(db, { ids: shown }),
    readInterfaces(db, shown),
    recordedVersions(db, shown),
    builderRunsIn(db, ecosystemId),
    versionsOf(db, [...new Set(links.map((l) => l.providerProjectId))]),
  ]);
  const impacts = impactsAgainstLatest(links, linked, (p) => {
    const i = interfaces.get(p);
    return i ? heldInterface(i, p).document.commitments.versioning : 'dated';
  });
  const latest = currentVersions(versions);
  const builders = latestBuilderRuns(runs, new Set(shown));
  const contracts = [...interfaces].flatMap(([provider, stored]) =>
    Object.entries(heldInterface(stored, provider).document.publishes)
      .filter(([, pub]) => pub.ecosystems.includes(ecosystemId))
      .map(([slug, pub]) => ({
        provider,
        slug,
        title: pub.title,
        type: pub.type,
        lifecycle: pub.lifecycle,
        currentVersion: latest.get(`${provider}/${slug}`) ?? null,
      })),
  );
  const doc = eco.document;
  return {
    ecosystem: { id: eco.id, slug: doc.ecosystem.slug, name: doc.ecosystem.name },
    projects: projects
      .map((p) => ({ id: p.id, slug: p.slug, name: p.name, builder: builders.get(p.id) ?? null }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    contracts: contracts.sort((a, b) =>
      `${a.provider}/${a.slug}`.localeCompare(`${b.provider}/${b.slug}`),
    ),
    links: links.map((l) => ({
      id: l.id,
      consumer: l.projectId,
      module: l.modulePath,
      contract: { provider: l.providerProjectId, slug: l.contractSlug },
      state: l.state,
      pinnedVersion: l.pinnedVersion,
      outsideContract: storedLink(l).outsideContract.length,
      impact: impacts.get(l.id) ?? null,
      updatedAt: l.updatedAt.toISOString(),
    })),
  };
}
