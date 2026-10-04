import { db } from '../../db/client.js';
import { resolveSourceHost, type SourceHost } from '../../integrations/source-host/index.js';
import { logger } from '../../logger.js';
import { readProjectConfig } from '../../project-config/service.js';
import { boss } from '../../queue/boss.js';
import { loadInterface } from '../interface-service.js';
import { projectsWhere } from '../store.js';
import { MAX_ARTIFACT_BYTES } from './measure.js';
import { recordVersion } from './record.js';
import {
  latestVersion,
  type MeasurementRow,
  openMeasurements,
  readMeasurement,
  settleMeasurement,
} from './store.js';

export const CONTRACT_MEASURE_QUEUE = 'ecosystem-contract-measure';

const COMMIT = /^[0-9a-f]{40}$/;
const NO_COMMIT = /^0{40}$/;

export interface LandJob {
  projectId: string;
  bindingId: string;
  measurementIds: string[];
}

export async function environmentsDeployingFrom(
  projectId: string,
  branch: string,
): Promise<string[]> {
  const project = await readProjectConfig(projectId);
  const doc = project?.document;
  if (doc?.source.type !== 'git') return [];
  return Object.entries(doc.environments)
    .filter(([, env]) => env.deploysFrom === branch)
    .map(([name]) => name)
    .sort();
}

// cm:why the push is the land: the host signs it, it arrives for every way a branch moves (a Forge merge, a person's merge, a direct push), and its sha is re-read from the repository rather than taken from anyone's claim
export async function observeLand(input: {
  projectId: string;
  bindingId: string;
  branch: string;
  commit: string | undefined;
}): Promise<number> {
  const { projectId, bindingId, branch, commit } = input;
  if (!commit || NO_COMMIT.test(commit) || !COMMIT.test(commit)) return 0;
  const environments = await environmentsDeployingFrom(projectId, branch);
  if (environments.length === 0) return 0;
  const iface = await loadInterface(projectId);
  const measured = Object.entries(iface?.document.publishes ?? {}).filter(
    ([, pub]) => pub.artifact !== null && 'path' in pub.artifact,
  );
  if (measured.length === 0) return 0;
  const rows = await openMeasurements(
    measured.map(([slug]) => ({
      providerProjectId: projectId,
      contractSlug: slug,
      commitSha: commit,
      branch,
      environments,
    })),
  );
  if (rows.length === 0) return 0;
  const job: LandJob = { projectId, bindingId, measurementIds: rows.map((r) => r.id) };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss send signature varies
    await (boss as any).send(CONTRACT_MEASURE_QUEUE, job, {
      retryLimit: 3,
      retryBackoff: true,
      singletonKey: `${projectId}:${commit}`,
    });
  } catch (err) {
    const reason = `the measurement could not be queued: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ projectId, commit, err }, `contract land: ${reason}`);
    for (const r of rows) await settleMeasurement(r.id, 'refused', { reason });
  }
  return rows.length;
}

async function isBehind(host: SourceHost, base: string, head: string): Promise<boolean> {
  if (base === head) return false;
  return (await host.compare(base, head)) === 'behind';
}

async function measureOne(
  host: SourceHost,
  row: MeasurementRow,
  providerSlug: string,
): Promise<void> {
  const iface = await loadInterface(row.providerProjectId);
  const pub = iface?.document.publishes[row.contractSlug];
  if (!iface || !pub?.artifact || !('path' in pub.artifact)) {
    return settleMeasurement(row.id, 'refused', {
      reason: `${providerSlug}/${row.contractSlug} is no longer published from a repository path`,
    });
  }
  const latest = await latestVersion(db, row.providerProjectId, row.contractSlug);
  const at = latest?.document.artifact;
  if (at && 'sourceCommit' in at && (await isBehind(host, at.sourceCommit, row.commitSha))) {
    return settleMeasurement(row.id, 'stale', {
      reason: `${row.commitSha} is behind ${at.sourceCommit}, where version ${latest?.version} was measured`,
    });
  }
  const text = await host.readFile(pub.artifact.path, row.commitSha, MAX_ARTIFACT_BYTES);
  if (typeof text !== 'string')
    return settleMeasurement(row.id, 'refused', { reason: text.missing });
  const out = await recordVersion({
    providerProjectId: row.providerProjectId,
    contractRef: `${providerSlug}/${row.contractSlug}`,
    publication: pub,
    versioning: iface.document.commitments.versioning,
    artifact: { text, origin: { sourceCommit: row.commitSha } },
  });
  if (out.outcome === 'refused') {
    const { code, detail } = out.problem;
    const reason = code === 'ARTIFACT_UNREADABLE' ? `${code}: ${detail}` : detail;
    return settleMeasurement(row.id, 'refused', { reason });
  }
  if (out.outcome === 'unchanged') {
    return settleMeasurement(row.id, 'unchanged', {
      reason: `the artifact is the one version ${out.version.contractVersion} was measured from`,
    });
  }
  return settleMeasurement(row.id, 'recorded', { version: out.version.contractVersion });
}

export async function measureLand(job: LandJob): Promise<void> {
  const [project] = await projectsWhere(db, { ids: [job.projectId] });
  let host: SourceHost | null = null;
  let refusal: string | null = null;
  try {
    host = await resolveSourceHost(job.projectId, 'kernel');
    if (host.bindingId !== job.bindingId)
      refusal = `the push came through binding ${job.bindingId}, and the project's source host binding is now ${host.bindingId}`;
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  }
  for (const id of job.measurementIds) {
    const row = await readMeasurement(id);
    if (row?.outcome !== 'pending') continue;
    if (!project || !host || refusal) {
      await settleMeasurement(id, 'refused', {
        reason: refusal ?? `project ${job.projectId} is gone`,
      });
      continue;
    }
    try {
      await measureOne(host, row, project.slug);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ measurementId: id, err }, 'contract land: the measurement failed');
      await settleMeasurement(id, 'refused', {
        reason: `${(err as { code?: string }).code ?? 'MEASUREMENT_FAILED'}: ${reason}`,
      });
    }
  }
}

let registered = false;

export async function registerContractMeasureWorker(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(CONTRACT_MEASURE_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(CONTRACT_MEASURE_QUEUE, { batchSize: 1 }, async (arg: unknown) => {
    for (const entry of Array.isArray(arg) ? arg : [arg]) {
      const data = (entry as { data?: LandJob })?.data;
      if (data && Array.isArray(data.measurementIds)) await measureLand(data);
    }
  });
  registered = true;
}
