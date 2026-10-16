/**
 * The two Coolify log reads: a deployment's build log and a target's live container log. Served
 * over REST by coolify-routes.ts, which the forge CLI calls.
 */

import {
  type CoolifyConfig,
  fetchCoolifyDeploymentLogs,
  fetchCoolifyRuntimeLogs,
} from '../integrations/deploy/index.js';
import { findLastOutbound } from '../integrations/index.js';
import {
  activeCoolifyIntegrations,
  refuseCoolify,
  resolveIntegrationRow,
} from '../release-batch/index.js';

interface LogsInput {
  integrationId?: string | undefined;
  deploymentUuid?: string | undefined;
  resourceUuid?: string | undefined;
  lines?: number | undefined;
}

/** A deployment's build log: the named deployment, else the integration's last outbound one. */
export async function coolifyDeploymentLogs(projectId: string, input: LogsInput) {
  const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
  if (!row)
    return { integrationId: null, deploymentUuid: null, logs: null, reason: 'no-integration' };
  const last = input.deploymentUuid ? null : await findLastOutbound(row.id);
  const deploymentUuid =
    input.deploymentUuid ??
    (last?.response as { deployment_uuid?: string } | null)?.deployment_uuid ??
    null;
  if (!deploymentUuid) {
    return { integrationId: row.id, deploymentUuid: null, logs: null, reason: 'no-deployment' };
  }
  return {
    integrationId: row.id,
    ...(await fetchCoolifyDeploymentLogs(row.pair, deploymentUuid, input.lines)),
  };
}

/**
 * The live container log of one target: the named resourceUuid, else the integration's sole target.
 * For a docker-compose application Coolify returns one container's log, whichever target is named.
 */
export async function coolifyRuntimeLogs(projectId: string, input: LogsInput) {
  const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
  if (!row)
    return { integrationId: null, resourceUuid: null, logs: null, reason: 'no-integration' };
  const targets = (row.config as CoolifyConfig | null)?.targets ?? [];
  const resourceUuid =
    input.resourceUuid ?? (targets.length === 1 ? targets[0]?.resourceUuid : undefined);
  if (!resourceUuid) {
    if (targets.length === 0)
      return { integrationId: row.id, resourceUuid: null, logs: null, reason: 'no-target' };
    throw refuseCoolify(
      'COOLIFY_TARGET_UNRESOLVED',
      'this integration has several targets — pass resourceUuid, as GET /integrations/coolify lists them',
    );
  }
  return {
    integrationId: row.id,
    ...(await fetchCoolifyRuntimeLogs(row.pair, resourceUuid, input.lines)),
  };
}
