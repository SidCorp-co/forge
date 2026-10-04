import { db } from '../../db/client.js';
import { effectiveProjectRole } from '../../lib/authz.js';
import { holds } from '../../permissions/index.js';
import { forbidden, notFound } from '../access.js';
import { loadGraph } from '../graph.js';
import { loadInterface } from '../interface-service.js';
import { liveEdges } from '../party.js';
import { activeEcosystemIdsOf, projectsWhere } from '../store.js';
import { type MeasurementRow, measurementsOf, type StoredVersion, versionsOf } from './store.js';

// cm:why a consumer reads a provider's contract only through a live consumption edge in an ecosystem the provider still publishes it to, and only as the project it holds a role on
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

/** A measurement as a consumer reads it: what was measured where, never the provider's branch, commit or reason. */
export const measurementForParty = (r: MeasurementRow) => ({
  outcome: r.outcome,
  version: r.version,
  environments: r.environments,
  observedAt: r.observedAt.toISOString(),
  settledAt: r.settledAt?.toISOString() ?? null,
});

export async function consumedVersions(providerId: string, contract: string) {
  return (await versionsOf(db, [providerId], contract)).map(versionForParty);
}

export async function consumedMeasurements(providerId: string, contract: string) {
  return (await measurementsOf(providerId, contract, 100)).map(measurementForParty);
}
