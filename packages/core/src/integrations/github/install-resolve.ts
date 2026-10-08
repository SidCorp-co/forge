/**
 * Which GitHub App the caller can reach owns an installation.
 *
 * GitHub sends `state` back to `setup_url` only when the operator followed the
 * link Forge handed them. Installing the App from its own settings page — the
 * page GitHub itself lands you on after creating it — omits `state` entirely,
 * so the last step of the flow has to identify the binding from the
 * installation alone.
 */

import { HTTPException } from 'hono/http-exception';
import { effectiveProjectRole } from '../../lib/authz.js';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  listBindingsForConnection,
} from '../store.js';
import { buildAppJwt } from './app-auth.js';
import { listGithubAppsReachableBy } from './install-candidates.js';
import { GITHUB_API_BASE } from './types.js';

export const installNotCompletable = (connection: { id: string; displayName: string | null }) =>
  new HTTPException(403, {
    message:
      `GitHub App ${connection.displayName ? `"${connection.displayName}" ` : ''}(connection ` +
      `${connection.id}) owns this installation, but it is bound only to projects you do not ` +
      'administer, so you cannot record the installation on one of them. An admin of a project ' +
      "it is bound to (or an owner or admin of that project's organization) can finish it from " +
      "that project's GitHub settings.",
    cause: { code: 'INSTALL_NOT_COMPLETABLE' },
  });

/** Resolved per project: the right to record an installation is the caller's admin role on it (ISS-1216). */
export async function findBindingOwningInstallation(args: {
  userId: string;
  installationId: number;
  fetchImpl?: typeof fetch;
}): Promise<BindingWithConnection | null> {
  const doFetch = args.fetchImpl ?? fetch;
  const connections = await listGithubAppsReachableBy(args.userId);

  for (const connection of connections) {
    const { appId, privateKey } = decryptConnectionSecrets<{
      appId?: string;
      privateKey?: string;
    }>(connection);
    if (!appId || !privateKey) continue;

    let ok = false;
    try {
      const res = await doFetch(`${GITHUB_API_BASE}/app/installations/${args.installationId}`, {
        headers: {
          authorization: `Bearer ${buildAppJwt(appId, privateKey)}`,
          accept: 'application/vnd.github+json',
        },
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) continue;

    const pairs = (await listBindingsForConnection(connection.id)).filter(
      (p) => p.binding.provider === 'github',
    );
    if (pairs.length === 0) continue;
    for (const pair of pairs) {
      const access = await effectiveProjectRole(args.userId, pair.binding.projectId);
      if (access?.role === 'admin') return pair;
    }
    throw installNotCompletable(connection);
  }

  return null;
}
