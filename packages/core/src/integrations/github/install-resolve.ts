/**
 * Which GitHub App the caller can reach owns an installation.
 *
 * GitHub sends `state` back to `setup_url` only when the operator followed the
 * link Forge handed them. Installing the App from its own settings page — the
 * page GitHub itself lands you on after creating it — omits `state` entirely,
 * so the last step of the flow has to identify the binding from the
 * installation alone.
 */

import {
  decryptConnectionSecrets,
  type IntegrationConnectionRow,
  listBindingsForConnection,
} from '../store.js';
import { listGithubAppsReachableBy } from './install-candidates.js';
import { appOctokit } from './octokit.js';

export async function findConnectionOwningInstallation(args: {
  userId: string;
  installationId: number;
  fetchImpl?: typeof fetch;
}): Promise<{ connection: IntegrationConnectionRow; projectId: string | null } | null> {
  const fetchOpt = args.fetchImpl ? { fetchImpl: args.fetchImpl } : {};
  const connections = await listGithubAppsReachableBy(args.userId);

  for (const connection of connections) {
    const { appId, privateKey } = decryptConnectionSecrets<{
      appId?: string;
      privateKey?: string;
    }>(connection);
    if (!appId || !privateKey) continue;

    let ok = false;
    try {
      await appOctokit({ appId, privateKey, ...fetchOpt }).request({
        method: 'GET',
        url: `/app/installations/${args.installationId}`,
      });
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) continue;

    const pair = (await listBindingsForConnection(connection.id)).find(
      (p) => p.binding.provider === 'github',
    );
    return { connection, projectId: pair?.binding.projectId ?? null };
  }

  return null;
}
