import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { BindingRole } from '../../db/schema.js';
import { projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
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

/** The clone URL for a repository this App reaches. */
export function githubHttpsRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/** `owner/repo` of a GitHub URL in either transport, for comparing two URLs. */
export function repoSlugFromGitUrl(url: string): string | null {
  const m = url
    .trim()
    .match(
      /^(?:https:\/\/[^/]*github\.com\/|git@[^:]*github\.com:|ssh:\/\/git@[^/]*github\.com\/)(.+?)(?:\.git)?$/i,
    );
  return m?.[1]?.toLowerCase() ?? null;
}

export type RepoUrlOutcome =
  | { kind: 'set'; repoUrl: string }
  | { kind: 'unchanged' }
  | { kind: 'conflict'; existing: string; bound: string };

/**
 * Fill `projects.repo_url` from the repository just bound, so it is chosen once
 * in the picker rather than retyped in project settings.
 */
export async function syncRepoUrlFromGitHubBinding(args: {
  projectId: string;
  role: BindingRole;
  config: GitHubConfig;
}): Promise<RepoUrlOutcome> {
  const { owner, repo } = args.config;
  if (args.role !== 'service' || !owner || !repo) return { kind: 'unchanged' };

  const bound = githubHttpsRepoUrl(owner, repo);
  const [row] = await db
    .select({ repoUrl: projects.repoUrl })
    .from(projects)
    .where(eq(projects.id, args.projectId))
    .limit(1);

  const existing = row?.repoUrl?.trim() ?? '';
  if (existing) {
    if (repoSlugFromGitUrl(existing) === `${owner}/${repo}`.toLowerCase())
      return { kind: 'unchanged' };
    logger.warn(
      { projectId: args.projectId, existing, bound },
      'github bind: project already clones a different repository; leaving its repo URL alone',
    );
    return { kind: 'conflict', existing, bound };
  }

  await db.update(projects).set({ repoUrl: bound }).where(eq(projects.id, args.projectId));
  logger.info(
    { projectId: args.projectId, repoUrl: bound },
    'github bind: set the project repo URL',
  );
  return { kind: 'set', repoUrl: bound };
}
