import { createHash } from 'node:crypto';
import { db } from '../../db/client.js';
import { type GitHubRepoClient, githubRepoClient } from '../../integrations/github/client.js';
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

// cm:why the push is the land: GitHub signs it, it arrives for every way a branch moves (a Forge merge, a person's merge, a direct push), and its sha is re-read from the repository rather than taken from anyone's claim
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

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// cm:why the contents API stops carrying bytes past 1MB, so the blob is read by the sha GitHub names and the bytes are held to that sha before core hashes them for itself
export async function artifactAt(
  client: GitHubRepoClient,
  path: string,
  commit: string,
): Promise<string | { missing: string }> {
  const repo = `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}`;
  let entry: { type?: string; sha?: string; size?: number };
  try {
    entry = await client.get(`${repo}/contents/${encodePath(path)}?ref=${commit}`);
  } catch (err) {
    if ((err as { status?: number }).status === 404)
      return { missing: `${path} does not exist at ${commit}` };
    throw err;
  }
  if (entry.type !== 'file' || !entry.sha)
    return {
      missing: `${path} at ${commit} is a ${entry.type ?? 'thing'} with no blob, not a file`,
    };
  if ((entry.size ?? 0) > MAX_ARTIFACT_BYTES)
    return {
      missing: `${path} at ${commit} is ${entry.size} bytes, over the ${MAX_ARTIFACT_BYTES} an artifact may be`,
    };
  const blob = await client.get<{ content?: string; encoding?: string }>(
    `${repo}/git/blobs/${entry.sha}`,
  );
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error(`GitHub served blob ${entry.sha} with encoding ${blob.encoding ?? 'none'}`);
  }
  const bytes = Buffer.from(blob.content, 'base64');
  const git = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (git !== entry.sha)
    throw new Error(
      `blob ${entry.sha} hashed to ${git}; the bytes GitHub served are not the file it named`,
    );
  return bytes.toString('utf8');
}

async function isBehind(client: GitHubRepoClient, base: string, head: string): Promise<boolean> {
  if (base === head) return false;
  const repo = `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}`;
  const cmp = await client.get<{ status?: string }>(`${repo}/compare/${base}...${head}`);
  return cmp.status === 'behind';
}

async function measureOne(
  client: GitHubRepoClient,
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
  if (at && 'sourceCommit' in at && (await isBehind(client, at.sourceCommit, row.commitSha))) {
    return settleMeasurement(row.id, 'stale', {
      reason: `${row.commitSha} is behind ${at.sourceCommit}, where version ${latest?.version} was measured`,
    });
  }
  const text = await artifactAt(client, pub.artifact.path, row.commitSha);
  if (typeof text !== 'string')
    return settleMeasurement(row.id, 'refused', { reason: text.missing });
  const out = await recordVersion({
    providerProjectId: row.providerProjectId,
    contractRef: `${providerSlug}/${row.contractSlug}`,
    publication: pub,
    versioning: iface.document.commitments.versioning,
    artifact: { text, origin: { sourceCommit: row.commitSha } },
  });
  if (out.outcome === 'refused')
    return settleMeasurement(row.id, 'refused', { reason: out.problem.detail });
  if (out.outcome === 'unchanged') {
    return settleMeasurement(row.id, 'unchanged', {
      reason: `the artifact is the one version ${out.version.contractVersion} was measured from`,
    });
  }
  return settleMeasurement(row.id, 'recorded', { version: out.version.contractVersion });
}

export async function measureLand(job: LandJob): Promise<void> {
  const [project] = await projectsWhere(db, { ids: [job.projectId] });
  let client: GitHubRepoClient | null = null;
  let refusal: string | null = null;
  try {
    client = await githubRepoClient(job.projectId);
    if (client.bindingId !== job.bindingId)
      refusal = `the push came through binding ${job.bindingId}, and the project's GitHub binding is now ${client.bindingId}`;
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  }
  for (const id of job.measurementIds) {
    const row = await readMeasurement(id);
    if (row?.outcome !== 'pending') continue;
    if (!project || !client || refusal) {
      await settleMeasurement(id, 'refused', {
        reason: refusal ?? `project ${job.projectId} is gone`,
      });
      continue;
    }
    try {
      await measureOne(client, row, project.slug);
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
