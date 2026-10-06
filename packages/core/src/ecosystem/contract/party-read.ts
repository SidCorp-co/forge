import { db } from '../../db/client.js';
import { effectiveProjectRole } from '../../lib/authz.js';
import { holds } from '../../permissions/index.js';
import { forbidden, notFound, readerProjects } from '../access.js';
import { loadGraph } from '../graph.js';
import { loadInterface } from '../interface-service.js';
import { activeEcosystemIdsOf } from '../membership-store.js';
import { liveEdges, offeredSight } from '../party.js';
import { projectsWhere } from '../store.js';
import { type StoredVersion, versionsOf } from './store.js';

// a consumer reads a provider's contract only through a live consumption edge in an ecosystem the provider still publishes it to, and only as the project it holds a role on
export async function consumedContract(args: {
  userId: string;
  consumerId: string;
  providerId: string;
  contract: string;
}): Promise<{ provider: { id: string; slug: string; name: string }; ecosystems: string[] }> {
  const { userId, consumerId, providerId, contract } = args;
  const access = await effectiveProjectRole(userId, consumerId);
  if (!(access ? holds(access, 'project.read') : false)) {
    throw forbidden(
      `person ${userId} holds no role on project ${consumerId}, so nothing is read as that project; a project admin can add them.`,
    );
  }
  const [provider] = await projectsWhere(db, { ids: [providerId] });
  const providerEcos = (await activeEcosystemIdsOf(db, [providerId])).map((m) => m.ecosystemId);
  const [graph, iface] = await Promise.all([loadGraph(providerEcos), loadInterface(providerId)]);
  const publishedTo = new Set(iface?.document.publishes[contract]?.ecosystems ?? []);
  const ecosystems = liveEdges(graph)
    .filter(
      (e) =>
        e.consumerProjectId === consumerId &&
        e.providerProjectId === providerId &&
        e.contractSlug === contract &&
        publishedTo.has(e.ecosystemId),
    )
    .map((e) => e.ecosystemId);
  if (!provider || ecosystems.length === 0) {
    throw notFound(
      `project ${consumerId} does not consume ${contract} of project ${providerId} in an ecosystem both are active in and the provider publishes it to; a contract's versions are read by its provider's members and by the projects that consume it.`,
    );
  }
  return { provider: { id: provider.id, slug: provider.slug, name: provider.name }, ecosystems };
}

/** A recorded version as a consumer reads it: the published diff, never the commit or the person that produced it. */
export const versionForParty = (v: StoredVersion) => ({
  contractVersion: v.document.contractVersion,
  previous: v.document.previous ?? null,
  observedAt: v.document.observedAt,
  artifact: v.document.artifact ? { sha256: v.document.artifact.sha256 } : null,
  diff: {
    tool: v.document.diff.tool,
    classification: v.document.diff.classification,
    changes: v.document.diff.changes,
  },
});

// a version the provider has not approved is not yet its word: a party never reads a proposed or returned one
const approvedOnly = (versions: readonly StoredVersion[]) =>
  versions.filter((v) => v.approval === 'approved');

export async function consumedVersions(providerId: string, contract: string) {
  return approvedOnly(await versionsOf(db, [providerId], contract)).map(versionForParty);
}

export type ContractReader = { access: 'project' } | { access: 'party'; ecosystems: string[] };

// who reads a provider's contract versions: its members every version, and an active member of an ecosystem the contract is published to its approved ones, consuming it or not yet
export async function contractReader(
  userId: string,
  providerId: string,
  contract: string,
): Promise<ContractReader> {
  const [provider] = await projectsWhere(db, { ids: [providerId] });
  if (!provider) throw notFound(`project ${providerId} does not exist`);
  const access = await effectiveProjectRole(userId, providerId);
  if (access && holds(access, 'project.read')) return { access: 'project' };
  const providerEcos = (await activeEcosystemIdsOf(db, [providerId])).map((m) => m.ecosystemId);
  const [graph, iface, reader] = await Promise.all([
    loadGraph(providerEcos),
    loadInterface(providerId),
    readerProjects(userId),
  ]);
  const publishedTo = new Set(iface?.document.publishes[contract]?.ecosystems ?? []);
  const offered = offeredSight(graph, reader, providerId, publishedTo);
  if (offered.size === 0) {
    throw forbidden(
      `${contract} of project ${providerId} is read by the provider's members and by the active members of an ecosystem it is published to; no project this caller reads as is one.`,
    );
  }
  return { access: 'party', ecosystems: [...offered.keys()] };
}

/** The versions a reader is shown, newest first: every one to a member, the approved ones to a party. */
export const versionsFor = (reader: ContractReader, versions: readonly StoredVersion[]) =>
  reader.access === 'project' ? [...versions] : approvedOnly(versions);
