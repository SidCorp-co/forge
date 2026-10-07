/**
 * Which reader answers for a project's repository (ISS-1398), decided the way `resolveLiveSource`
 * decides it: the active GitHub binding; only where there is no binding at all, the SSH deploy key
 * attached to the project; and a binding that exists and cannot be used is refused in its own
 * words, never answered from the key instead.
 */

import { HTTPException } from 'hono/http-exception';
import { GIT_ACCESS } from '../git/bounded-fetch.js';
import { gitRepositoryReader } from '../git/repository-reading.js';
import { withDeployKey } from '../git/ssh-keys.js';
import { githubRepositoryReader } from '../integrations/github/repository-reader.js';
import { type LiveSource, resolveLiveSource } from './live-source.js';
import type { RepositoryAccess, RepositoryRoute } from './repository-reader.js';

export interface RepositoryAccessDeps {
  source: (projectId: string) => Promise<LiveSource>;
  deployKey: typeof withDeployKey;
}

const defaultDeps: RepositoryAccessDeps = {
  source: (projectId) => resolveLiveSource(projectId),
  deployKey: withDeployKey,
};

/** How "mark again once …" ends for a repository read through `route`. */
export function readableThrough(route: RepositoryRoute): string {
  return route === 'github'
    ? "once the tracker can read the project's repository, through a GitHub binding whose installation can read it"
    : `once the tracker can read the project's repository with the deploy key attached under ${GIT_ACCESS}, over the SSH clone URL set there`;
}

/**
 * `fn` with the project's repository: a reader, or why there is none. A deploy-key reading lives
 * only as long as `fn`, its key and fetched repositories removed when `fn` returns.
 */
export async function withRepository<T>(
  projectId: string,
  fn: (access: RepositoryAccess) => Promise<T>,
  deps: Partial<RepositoryAccessDeps> = {},
): Promise<T> {
  const { source: sourceOf, deployKey } = { ...defaultDeps, ...deps };
  const source = await sourceOf(projectId);
  if (source.kind === 'refused') {
    const { reason, unbound, route } = source;
    return fn({ kind: 'refused', why: reason, unbound, route });
  }
  if (source.kind === 'binding') {
    return fn({ kind: 'reader', reader: githubRepositoryReader(source.client) });
  }
  const { repoUrl, privateKey } = source;
  let entered = false;
  try {
    return await deployKey(privateKey, repoUrl, (env, dir, pin) => {
      entered = true;
      return fn({ kind: 'reader', reader: gitRepositoryReader(repoUrl, env, dir, { pin }) });
    });
  } catch (err) {
    // The host guard refuses the remote before any key is written; past that, `fn`'s own throw.
    if (entered || !(err instanceof HTTPException)) throw err;
    return fn({
      kind: 'refused',
      why: `${repoUrl} cannot be read: ${err.message}`,
      unbound: false,
      route: 'deploy_key',
    });
  }
}
