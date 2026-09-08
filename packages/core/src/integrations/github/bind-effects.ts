/**
 * What binding a GitHub repository to a project must also settle.
 *
 * Two things the picker knows and nothing else does: the webhook secret GitHub
 * will actually sign with, and the URL the repository is cloned from. Leaving
 * either to be typed again is how a project ends up bound to one repository and
 * cloning another.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { decryptConnectionSecrets, type IntegrationConnectionRow } from '../store.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

/**
 * The inbound HMAC secret a GitHub binding must carry: the App's own, never a
 * minted one.
 */
// cm:guard GitHub signs every delivery with the secret it generated when the App was created, so a binding that mints its own fails EVERY signature check while the hub renders it as configured — no delivery row, no error anyone sees. `adapter.handleInbound` verifies against `ctx.integrationSecret`, which is this value.
// cm:edge lockstep -> packages/core/src/integrations/github/connect-routes.ts — the manifest flow sets the same secret on the binding it creates; both entry points must agree or the second repository bound to an App is silently deaf.
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
// cm:guard FILL an empty repo URL, never overwrite one — the stored URL is what every runner already clones and may carry a transport and a host this binding knows nothing about (a GitLab mirror, an SSH remote with a deploy key). Report the disagreement to the caller instead; a bind is about webhooks and must not be able to repoint a project's git.
// cm:guard only a `prod` binding may drive it — a staging binding legitimately names a fork, and `projects.repo_url` is project-tier with nowhere to put a second one.
export async function syncRepoUrlFromGitHubBinding(args: {
  projectId: string;
  environment: string;
  config: GitHubConfig;
}): Promise<RepoUrlOutcome> {
  const { owner, repo } = args.config;
  if (args.environment !== 'prod' || !owner || !repo) return { kind: 'unchanged' };

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
