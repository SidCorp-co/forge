/**
 * A verified delivery from the instance's GitHub App, routed by what it is about rather than by the
 * URL it reached: one App serves every project, so the installation and repository a delivery names
 * pick the bindings it is for. Both doors route through here, the App-wide one and a project's slug
 * door an older App's hook still points at, once the App is the instance's.
 *
 * The signature is verified by the door before this is called; nothing here trusts an unverified
 * byte.
 */

import { logger } from '../../lib/logger.js';
import { isRefusal } from '../../lib/refusal.js';
import {
  buildContextFromBinding,
  effectiveConfig,
  getAdapter,
  type InboundDispatchInput,
  type IntegrationConnectionRow,
  listBindingsForConnection,
} from '../index.js';
import { noteInstallationRepositories, setInstallationState } from './installations.js';
import type { GitHubConfig } from './types.js';

interface AppDeliveryPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string } };
  repository?: { full_name?: string };
  repositories_added?: Array<{ full_name?: string }>;
  repositories_removed?: Array<{ full_name?: string }>;
}

export type AppDeliveryOutcome =
  | { kind: 'installation'; installationId: number; state: string; recorded: boolean }
  | { kind: 'repositories'; installationId: number; recorded: boolean }
  | { kind: 'ping' }
  | { kind: 'dropped'; reason: string }
  | {
      kind: 'routed';
      results: Array<{
        bindingId: string;
        projectId: string;
        deliveryId?: string;
        actions?: number;
        refusal?: string;
      }>;
      failed: number;
    };

const INSTALLATION_STATES = { deleted: 'gone', suspend: 'suspended', unsuspend: 'active' } as const;

const names = (list: Array<{ full_name?: string }> | undefined) =>
  (list ?? []).map((r) => r.full_name).filter((n): n is string => typeof n === 'string');

function dropped(reason: string, context: Record<string, unknown>): AppDeliveryOutcome {
  logger.info({ ...context, reason }, 'github app: delivery dropped, nothing written');
  return { kind: 'dropped', reason };
}

export async function routeAppDelivery(args: {
  connection: IntegrationConnectionRow;
  input: InboundDispatchInput;
}): Promise<AppDeliveryOutcome> {
  const { connection, input } = args;
  const event = input.headers['x-github-event'] ?? '';
  const payload = (input.payload ?? {}) as AppDeliveryPayload;
  const installationId = payload.installation?.id;
  const context = {
    connectionId: connection.id,
    event,
    action: payload.action ?? null,
    installationId: installationId ?? null,
    repository: payload.repository?.full_name ?? null,
    delivery: input.headers['x-github-delivery'] ?? null,
  };

  if (event === 'ping') return { kind: 'ping' };
  if (typeof installationId !== 'number') {
    return dropped('the delivery names no installation', context);
  }

  if (event === 'installation') {
    const state = INSTALLATION_STATES[payload.action as keyof typeof INSTALLATION_STATES] ?? null;
    if (!state) {
      // `created` is recorded only once its installer is proven, through Connect GitHub
      return dropped(
        `an installation ${payload.action ?? 'event'} changes nothing Forge records`,
        context,
      );
    }
    const row = await setInstallationState(connection.id, installationId, state);
    if (!row)
      return dropped('the installation is not recorded for any Forge organisation', context);
    logger.info({ ...context, state }, 'github app: installation state recorded');
    return { kind: 'installation', installationId, state, recorded: true };
  }

  if (event === 'installation_repositories') {
    const row = await noteInstallationRepositories(connection.id, installationId, {
      added: names(payload.repositories_added),
      removed: names(payload.repositories_removed),
    });
    if (!row)
      return dropped('the installation is not recorded for any Forge organisation', context);
    return { kind: 'repositories', installationId, recorded: true };
  }

  const repository = payload.repository?.full_name?.toLowerCase();
  if (!repository) return dropped('the delivery names no repository', context);

  const pairs = (await listBindingsForConnection(connection.id)).filter((pair) => {
    if (pair.binding.provider !== 'github' || !pair.binding.active) return false;
    const config = effectiveConfig<GitHubConfig>(pair);
    return (
      config.installationId === installationId &&
      `${config.owner ?? ''}/${config.repo ?? ''}`.toLowerCase() === repository
    );
  });
  if (pairs.length === 0) {
    return dropped('no binding uses this installation and repository', context);
  }

  const adapter = getAdapter('github');
  if (!adapter) throw new Error('github app: the github adapter is not registered');
  const results: Extract<AppDeliveryOutcome, { kind: 'routed' }>['results'] = [];
  let failed = 0;
  for (const pair of pairs) {
    const at = { bindingId: pair.binding.id, projectId: pair.binding.projectId };
    try {
      const result = await adapter.handleInbound(buildContextFromBinding(pair), input);
      results.push({
        ...at,
        deliveryId: result.deliveryId,
        actions: result.actions,
        ...(result.refusal ? { refusal: result.refusal } : {}),
      });
    } catch (err) {
      if (isRefusal(err)) {
        logger.warn({ ...context, ...at, refusal: err.message }, 'github app: delivery refused');
        results.push({ ...at, refusal: err.message });
        continue;
      }
      failed += 1;
      logger.error({ err, ...context, ...at }, 'github app: handler threw');
    }
  }
  return { kind: 'routed', results, failed };
}
