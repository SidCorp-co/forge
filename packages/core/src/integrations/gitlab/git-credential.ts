import type { GitCredentialMint } from '../index.js';
import { gitlabHostOf } from './types.js';

/** How long a helper answer is good for before git asks again. The token itself is the connection's. */
const ASK_AGAIN_MS = 60 * 60_000;

function pathOf(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/** The connection's token for the binding's own project and host; GitLab takes `oauth2` beside it. */
export const gitlabGitCredential: GitCredentialMint = {
  serves: (config) => typeof config.projectPath === 'string' && config.projectPath.length > 0,
  reaches(config, host, path) {
    const projectPath =
      typeof config.projectPath === 'string' ? config.projectPath.toLowerCase() : null;
    return (
      projectPath !== null &&
      gitlabHostOf(config) === host.toLowerCase() &&
      pathOf(path) === projectPath
    );
  },
  repositoryOf(config) {
    return `${gitlabHostOf(config)}/${String(config.projectPath ?? config.projectId ?? '(no project)')}`;
  },
  async mint({ config, secrets }) {
    const token = typeof secrets.token === 'string' ? secrets.token : '';
    if (!token)
      throw new Error(
        `the connection behind ${this.repositoryOf(config)} holds no GitLab access token`,
      );
    // the expiry is when git should ask again, not when the token dies: a GitLab access token outlives a job and the helper re-asks per invocation, so a short answer keeps a revoked binding from being cached
    return {
      username: 'oauth2',
      password: token,
      expiresAt: new Date(Date.now() + ASK_AGAIN_MS).toISOString(),
    };
  },
};
