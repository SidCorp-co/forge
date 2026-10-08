/** The GitHub Apps a caller may be completing an installation for: those they reach by `../reach.ts`. */

import { listReachableConnections } from '../reach.js';
import type { IntegrationConnectionRow } from '../store.js';

export async function listGithubAppsReachableBy(
  userId: string,
): Promise<IntegrationConnectionRow[]> {
  return (await listReachableConnections(userId))
    .map((reached) => reached.connection)
    .filter((connection) => connection.provider === 'github');
}
