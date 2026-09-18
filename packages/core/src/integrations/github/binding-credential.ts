/**
 * The config and secrets behind one GitHub binding, or the refusal in between.
 *
 * Split out of `contract-check.ts` by ISS-1073 so the merge path reads the
 * credential through the same function rather than a second copy of it. A
 * second copy is where one of the two active checks gets left out, which is the
 * shape `merge-marker.ts`'s own guard records from ISS-786.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings } from '../../db/schema.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

export type BindingCredential =
  | { config: GitHubConfig; secrets: GitHubSecrets }
  | { refusal: string };

// cm:guard both the BINDING and its CONNECTION are checked active, and neither check stands for the other: a binding survives its connection being deactivated (that is what the breaker does), and a deactivated connection still has a live binding pointing at it. Reading one is how a credential the operator revoked keeps being used.
export async function githubBindingCredential(bindingId: string): Promise<BindingCredential> {
  const [binding] = await db
    .select({ connectionId: integrationBindings.connectionId, config: integrationBindings.config })
    .from(integrationBindings)
    .where(and(eq(integrationBindings.id, bindingId), eq(integrationBindings.active, true)))
    .limit(1);
  if (!binding) {
    return {
      refusal: `the GitHub binding ${bindingId} this pull request was stored under is gone or deactivated`,
    };
  }
  const connection = await findConnectionById(binding.connectionId);
  if (!connection?.active) {
    return {
      refusal: "the GitHub connection behind this project's binding is gone or deactivated",
    };
  }
  return {
    config: (binding.config ?? {}) as GitHubConfig,
    secrets: decryptConnectionSecrets<GitHubSecrets>(connection),
  };
}
