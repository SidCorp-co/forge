import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings } from '../../db/schema.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

export type BindingCredential =
  | { config: GitHubConfig; secrets: GitHubSecrets }
  | { refusal: string };

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
