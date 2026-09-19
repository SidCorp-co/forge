/**
 * Coolify log READS — the build log of a deployment and the runtime log of a
 * live container. Split out of `adapter.ts` because neither is part of the
 * fixed `IntegrationAdapter` interface: the MCP `forge_coolify_deploy` tool
 * calls them directly, and adapter.ts was over its 500-line budget.
 */

import { scrubLogText } from '@forge/observability';
import { isPreviousCredentialValid } from '../rotation.js';
import { type BindingWithConnection, buildContextFromBinding } from '../store.js';
import { CoolifyClient } from './client.js';
import { flattenLogs, logDigest, redactCoolifyEnvDump, tailLog } from './logs.js';
import type { CoolifyConfig, CoolifySecrets } from './types.js';

/** Shared by the adapter's own dispatch and health paths, and both reads here. */
export function buildClient(ctx: {
  config: CoolifyConfig;
  secrets: CoolifySecrets;
}): CoolifyClient {
  const opts: ConstructorParameters<typeof CoolifyClient>[0] = {
    baseUrl: ctx.config.baseUrl,
    apiToken: ctx.secrets.apiToken,
  };
  if (ctx.secrets.previousApiToken && isPreviousCredentialValid(ctx.secrets)) {
    opts.previousApiToken = ctx.secrets.previousApiToken;
  }
  return new CoolifyClient(opts);
}

export interface CoolifyDeploymentLogsResult {
  deploymentUuid: string;
  status: string | null;
  /** Git SHA this deployment built, or null when Coolify did not report one. */
  commit: string | null;
  logs: string;
  /** True when the log was tailed (older lines or leading bytes dropped). */
  truncated: boolean;
  /** When these bytes were read from Coolify, ISO-8601. */
  fetchedAt: string;
  /** Short sha256 of the returned text — see {@link logDigest}. */
  logsDigest: string;
}

export async function fetchCoolifyDeploymentLogs(
  pair: BindingWithConnection,
  deploymentUuid: string,
  lines?: number,
): Promise<CoolifyDeploymentLogsResult> {
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair);
  const client = buildClient(ctx);
  const dep = await client.getDeployment(deploymentUuid);
  const raw = flattenLogs(dep.logs);
  const extraSecrets = [ctx.secrets.apiToken, ctx.secrets.previousApiToken].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const preRedacted = redactCoolifyEnvDump(raw);
  const scrubbed = scrubLogText(preRedacted, extraSecrets);
  const { text, truncated } = tailLog(scrubbed, lines);
  return {
    deploymentUuid,
    status: dep.status ?? null,
    commit: dep.commit ?? null,
    logs: text,
    truncated,
    fetchedAt: new Date().toISOString(),
    logsDigest: logDigest(text),
  };
}

export interface CoolifyRuntimeLogsResult {
  resourceUuid: string;
  logs: string;
  truncated: boolean;
  fetchedAt: string;
  logsDigest: string;
}

export async function fetchCoolifyRuntimeLogs(
  pair: BindingWithConnection,
  resourceUuid: string,
  lines?: number,
): Promise<CoolifyRuntimeLogsResult> {
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair);
  const client = buildClient(ctx);
  const res = await client.getApplicationLogs(
    resourceUuid,
    lines !== undefined ? { lines } : undefined,
  );
  const raw = typeof res.logs === 'string' ? res.logs : '';
  const extraSecrets = [ctx.secrets.apiToken, ctx.secrets.previousApiToken].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const scrubbed = scrubLogText(redactCoolifyEnvDump(raw), extraSecrets);
  const { text, truncated } = tailLog(scrubbed, lines);
  return {
    resourceUuid,
    logs: text,
    truncated,
    fetchedAt: new Date().toISOString(),
    logsDigest: logDigest(text),
  };
}
