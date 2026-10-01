import type { BindingRole } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { readDeclaredSource } from '../../project-config/source.js';
import { decryptConnectionSecrets, type IntegrationConnectionRow } from '../store.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

/**
 * The inbound HMAC secret a GitHub binding must carry: the App's own, never a
 * minted one.
 */
export function githubInboundSecret(connection: IntegrationConnectionRow): string | null {
  const secrets = decryptConnectionSecrets<GitHubSecrets>(connection);
  return secrets.webhookSecret ?? null;
}

export type BoundRepositoryOutcome =
  | { kind: 'not-a-repository' }
  | { kind: 'declared'; repository: string }
  | { kind: 'undeclared'; bound: string; detail: string }
  | { kind: 'conflict'; declared: string; bound: string; detail: string };

export async function compareBoundRepository(args: {
  projectId: string;
  role: BindingRole;
  config: GitHubConfig;
}): Promise<BoundRepositoryOutcome> {
  const { owner, repo } = args.config;
  if (args.role !== 'service' || !owner || !repo) return { kind: 'not-a-repository' };

  const bound = `github.com/${owner}/${repo}`;
  const { repository: declared } = await readDeclaredSource(args.projectId);
  if (declared === null) {
    return {
      kind: 'undeclared',
      bound,
      detail: `the project document declares no repository: set \`source.git.repository\` to "${bound}" with PUT /api/projects/:id/config. Binding a repository does not write the document.`,
    };
  }
  if (declared.toLowerCase() === bound.toLowerCase()) return { kind: 'declared', repository: declared };
  logger.warn(
    { projectId: args.projectId, declared, bound },
    'github bind: the bound repository is not the one the project document declares',
  );
  return {
    kind: 'conflict',
    declared,
    bound,
    detail: `the project document declares "${declared}", and this binding reaches "${bound}": the document is what work is cut from, so change it with PUT /api/projects/:id/config or bind the declared repository.`,
  };
}
