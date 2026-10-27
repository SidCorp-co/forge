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
import { logger } from '../../logger.js';
import {
  CredentialUnreadable,
  installOwnerUnreadable,
  type UnreadableCredential,
} from '../credential-unreadable.js';
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
      `${connection.id}) owns this installation, but it is shared only with projects you do not ` +
      'administer, so you cannot record the installation on one of them. An admin of a project ' +
      "it is shared with (or an owner or admin of that project's organization) can finish it from " +
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
  // An App this server cannot read is skipped for matching, so it does not refuse an install another
  // App owns, and is named either way (ISS-1259 r2).
  const unreadable: UnreadableCredential[] = [];

  for (const connection of connections) {
    let secrets: { appId?: string; privateKey?: string };
    try {
      secrets = decryptConnectionSecrets(connection, null);
    } catch (err) {
      if (!(err instanceof CredentialUnreadable)) throw err;
      unreadable.push(err.credential);
      continue;
    }
    const { appId, privateKey } = secrets;
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
    if (unreadable.length > 0) {
      logger.warn(
        { installationId: args.installationId, skipped: unreadable.map((c) => c.connectionId) },
        'github install: matched past Apps whose stored credential this server cannot decrypt',
      );
    }

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

  if (unreadable.length > 0) throw installOwnerUnreadable(args.installationId, unreadable);
  return null;
}
