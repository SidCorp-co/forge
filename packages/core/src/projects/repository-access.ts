/**
 * Which reader answers for a project's repository (ISS-1398), decided the way `resolveLiveSource`
 * decides it: the active GitHub binding; only where there is no binding at all, the SSH deploy key
 * attached to the project; and a binding that exists and cannot be used is refused in its own
 * words, never answered from the key instead.
 */

import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { GIT_ACCESS, REPO_URL_AT, unresolvedHostRefusal } from '../git/bounded-fetch.js';
import { gitRepositoryReader } from '../git/repository-reading.js';
import { isHostUnresolved } from '../git/ssh-host-guard.js';
import { withDeployKey } from '../git/ssh-keys.js';
import { githubRepositoryReader } from '../integrations/github/repository-reader.js';
import { type LiveSource, resolveLiveSource } from './live-source.js';
import type { RepositoryAccess, RepositoryRoute } from './repository-reader.js';

export interface RepositoryAccessDeps {
  source: (projectId: string) => Promise<LiveSource>;
  deployKey: typeof withDeployKey;
}

const defaultDeps: RepositoryAccessDeps = {
  source: resolveLiveSource,
  deployKey: withDeployKey,
};

/** The "once …" clause naming what makes `repository` readable through `route` again, and the
 *  act a person takes for it, in a person's words: Forge, never "the tracker" (ISS-1300 r4). */
export function readableThrough(route: RepositoryRoute, repository: string | null = null): string {
  const repo = repository ?? "the project's repository";
  return route === 'binding'
    ? `once Forge can read ${repo} again: give the GitHub App installation behind this project's GitHub connection access to it, or connect the project to where it now lives`
    : `once Forge can read ${repo} again: attach a deploy key that can read it under ${GIT_ACCESS}, with the SSH clone URL set under ${REPO_URL_AT}`;
}

/** A deploy key's reach: the remote and a digest of the key, so two keys on one remote never share
 *  an answer and the key itself is never kept (ISS-1300 r4). */
export function deployKeyReach(repoUrl: string, privateKey: string): string {
  const key = createHash('sha256').update(privateKey.trim()).digest('hex').slice(0, 32);
  return `${repoUrl}#key-${key}`;
}

/** `fn` with a reader, or why there is none; a deploy-key reading is removed when `fn` returns. */
export async function withRepository<T>(
  projectId: string,
  fn: (access: RepositoryAccess) => Promise<T>,
  deps: Partial<RepositoryAccessDeps> = {},
): Promise<T> {
  const { source: sourceOf, deployKey } = { ...defaultDeps, ...deps };
  const source = await sourceOf(projectId);
  if (source.kind === 'refused') {
    const { cause, clears, unbound, route, noRepository } = source;
    const said = clears === undefined ? { cause } : { cause, clears };
    return fn({
      kind: 'refused',
      ...said,
      unbound,
      route,
      ...(noRepository ? { noRepository } : {}),
    });
  }
  if (source.kind === 'binding') {
    return fn({ kind: 'reader', reader: githubRepositoryReader(source.client) });
  }
  const { repoUrl, privateKey } = source;
  let entered = false;
  try {
    return await deployKey(privateKey, repoUrl, (env, dir, pin) => {
      entered = true;
      const reach = deployKeyReach(repoUrl, privateKey);
      return fn({ kind: 'reader', reader: gitRepositoryReader(repoUrl, env, dir, { reach, pin }) });
    });
  } catch (err) {
    // The host guard refuses the remote before any key is written; past that, `fn`'s own throw.
    if (entered || !(err instanceof HTTPException)) throw err;
    if (isHostUnresolved(err)) {
      return fn({
        kind: 'refused',
        ...unresolvedHostRefusal(repoUrl),
        unbound: false,
        route: 'deploy_key',
      });
    }
    return fn({
      kind: 'refused',
      cause: `${repoUrl} cannot be read: ${err.message}`,
      unbound: false,
      route: 'deploy_key',
    });
  }
}
