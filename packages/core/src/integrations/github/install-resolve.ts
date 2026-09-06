/**
 * Which of the caller's GitHub Apps owns an installation.
 *
 * GitHub sends `state` back to `setup_url` only when the operator followed the
 * link Forge handed them. Installing the App from its own settings page — the
 * page GitHub itself lands you on after creating it — omits `state` entirely,
 * so the last step of the flow has to identify the binding from the
 * installation alone.
 */

import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  listBindingsForConnection,
  listConnectionsForPrincipalUser,
} from '../store.js';
import { buildAppJwt } from './app-auth.js';
import { GITHUB_API_BASE } from './types.js';

// cm:guard prove ownership by asking GitHub, never by picking the caller's only candidate — an App JWT reads ONLY its own installations, so a 200 here is proof, where "they had one unconfigured binding" silently writes another project's installation id into this one the moment a second project connects
export async function findBindingOwningInstallation(args: {
  userId: string;
  installationId: number;
  fetchImpl?: typeof fetch;
}): Promise<BindingWithConnection | null> {
  const doFetch = args.fetchImpl ?? fetch;
  const connections = (await listConnectionsForPrincipalUser(args.userId)).filter(
    (c) => c.provider === 'github',
  );

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
      // cm:why one unreachable App must not decide the answer for the others — the next candidate may be the owner, and a network blip here would otherwise strand the install exactly as a missing `state` does
      ok = false;
    }
    if (!ok) continue;

    const pair = (await listBindingsForConnection(connection.id)).find(
      (p) => p.binding.provider === 'github',
    );
    if (pair) return pair;
  }

  return null;
}
