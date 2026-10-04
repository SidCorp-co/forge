import type { GitCredentialMint } from '../index.js';
import { mintInstallationToken } from './octokit.js';
import { githubHostOf } from './source-host.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

/** `owner/repo` out of git's helper path, or null for anything that is not exactly two segments. */
function parseRepoPath(raw: string): { owner: string; repo: string } | null {
  const parts = raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * A GitHub binding serves git an installation token for its own repository: an hour long, minted per
 * ask, so nothing on the box outlives the binding.
 */
export const githubGitCredential: GitCredentialMint = {
  serves: (config) => typeof config.installationId === 'number',
  reaches(config, host, path) {
    const parsed = parseRepoPath(path);
    const { owner, repo } = config as GitHubConfig;
    return (
      parsed !== null &&
      typeof owner === 'string' &&
      typeof repo === 'string' &&
      githubHostOf(config) === host.toLowerCase() &&
      parsed.owner.toLowerCase() === owner.toLowerCase() &&
      parsed.repo.toLowerCase() === repo.toLowerCase()
    );
  },
  repositoryOf(config) {
    const { owner, repo } = config as GitHubConfig;
    return `${owner ?? '?'}/${repo ?? '?'}`;
  },
  async mint({ config, secrets }) {
    const c = config as GitHubConfig;
    const s = secrets as GitHubSecrets;
    if (!c.installationId) {
      throw new Error(
        `${c.owner}/${c.repo} is bound but the App is not installed for that binding — install it on the account that owns ${c.owner}`,
      );
    }
    if (!s.appId || !s.privateKey) {
      throw new Error(`the connection behind ${c.owner}/${c.repo} holds no GitHub App credential`);
    }
    const { token, expiresAt } = await mintInstallationToken({
      appId: s.appId,
      privateKey: s.privateKey,
      installationId: c.installationId,
      ...(c.apiBaseUrl ? { apiBaseUrl: c.apiBaseUrl } : {}),
    });
    return {
      username: 'x-access-token',
      password: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  },
};
