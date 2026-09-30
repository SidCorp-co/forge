import type {
  DeployAdapter,
  DeploymentRecord,
  DeploymentStatus,
  TargetedDeployAdapter,
} from '../../project-config/deploy-adapters/types.js';
import type { AdapterContext } from '../types.js';
import { CoolifyApiError, type CoolifyClient } from './client.js';
import { buildClient } from './log-fetch.js';
import type { CoolifyConfig, CoolifyDeploymentResponse, CoolifySecrets } from './types.js';

export interface CoolifyDeployTarget {
  readonly applicationUuid: string;
}

const COOLIFY_STATUS: ReadonlyMap<string, DeploymentStatus> = new Map([
  ['queued', 'queued'],
  ['in_progress', 'running'],
  ['finished', 'succeeded'],
  ['failed', 'failed'],
  ['cancelled-by-user', 'cancelled'],
]);

const UNRECORDED_COMMIT = 'HEAD';
const LATEST_PAGE = 5;

export class CoolifyDeploymentRecordError extends Error {
  constructor(deploymentId: string, what: string) {
    super(`Coolify deployment ${deploymentId}: ${what}`);
    this.name = 'CoolifyDeploymentRecordError';
  }
}

export function mapCoolifyDeploymentStatus(deploymentId: string, raw: unknown): DeploymentStatus {
  const mapped = typeof raw === 'string' ? COOLIFY_STATUS.get(raw) : undefined;
  if (!mapped) {
    throw new CoolifyDeploymentRecordError(
      deploymentId,
      `status ${JSON.stringify(raw)} is not one Forge maps; the known statuses are ${[...COOLIFY_STATUS.keys()].join(', ')}`,
    );
  }
  return mapped;
}

function sourceRevisionOf(deploymentId: string, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === UNRECORDED_COMMIT) return null;
  if (typeof raw === 'string' && /^[0-9a-fA-F]{7,40}$/.test(raw)) return raw.toLowerCase();
  throw new CoolifyDeploymentRecordError(
    deploymentId,
    `commit ${JSON.stringify(raw)} is neither a git revision nor Coolify's unrecorded ${UNRECORDED_COMMIT}`,
  );
}

function timeOf(deploymentId: string, raw: unknown): string {
  const at = typeof raw === 'string' ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw new CoolifyDeploymentRecordError(
      deploymentId,
      `created_at ${JSON.stringify(raw)} is not a timestamp`,
    );
  }
  return at.toISOString();
}

export function toDeploymentRecord(raw: CoolifyDeploymentResponse): DeploymentRecord {
  const id = raw.deployment_uuid;
  if (typeof id !== 'string' || id === '') {
    throw new CoolifyDeploymentRecordError('(unnamed)', 'the record carries no deployment_uuid');
  }
  return {
    id,
    status: mapCoolifyDeploymentStatus(id, raw.status),
    at: timeOf(id, raw.created_at),
    sourceRevision: sourceRevisionOf(id, raw.commit),
    artifact: null,
  };
}

export function coolifyDeployAdapter(client: CoolifyClient): DeployAdapter<CoolifyDeployTarget> {
  return {
    provider: 'coolify',
    async latestDeployment(target) {
      const page = await client.listApplicationDeployments(target.applicationUuid, {
        take: LATEST_PAGE,
      });
      const records = (page.deployments ?? []).map(toDeploymentRecord);
      return records.reduce<DeploymentRecord | null>(
        (latest, r) => (latest === null || r.at > latest.at ? r : latest),
        null,
      );
    },
    async deployment(_target, id) {
      try {
        return toDeploymentRecord(await client.getDeployment(id));
      } catch (err) {
        if (err instanceof CoolifyApiError && err.status === 404) return null;
        throw err;
      }
    },
  };
}

export function coolifyDeploymentRecords(
  ctx: AdapterContext<CoolifyConfig, CoolifySecrets>,
  timeoutMs: number,
): TargetedDeployAdapter<CoolifyDeployTarget> {
  const targets = ctx.config.targets ?? [];
  const [only] = targets;
  if (targets.length !== 1 || !only) {
    throw new Error(
      `coolify binding ${ctx.bindingId} names ${targets.length} deploy targets; an environment reads the deployment record of exactly one application`,
    );
  }
  return {
    adapter: coolifyDeployAdapter(buildClient(ctx, timeoutMs)),
    target: { applicationUuid: only.resourceUuid },
  };
}
