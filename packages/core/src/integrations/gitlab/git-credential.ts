import type { RelayedGitCredential } from '../index.js';
import { GITLAB_DEFAULT_BASE_URL, gitlabHostOf } from './types.js';

/** How long a pre-relay helper answer is good for before git asks again; the token is the connection's. */
const ASK_AGAIN_MS = 60 * 60_000;

function tokenOf(secrets: Record<string, unknown>, repository: string): string {
  const token = typeof secrets.token === 'string' ? secrets.token : '';
  if (!token) throw new Error(`the connection behind ${repository} holds no GitLab access token`);
  return token;
}

function pathOf(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/**
 * GitLab mints nothing short-lived a box may hold for one repository: a project access token lives a
 * day at least, needs the Maintainer role on a self-managed or paid instance, and makes a bot user per
 * token. So git goes through Forge's relay (REQ-73 BC-5): the box holds a one-hour relay ticket, and
 * the connection's token is added to the relayed request in core, never handed out.
 */
export const gitlabGitCredential: RelayedGitCredential = {
  kind: 'relayed',
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
  upstream({ config, secrets }) {
    const token = tokenOf(secrets, this.repositoryOf(config));
    const base = (
      typeof config.baseUrl === 'string' ? config.baseUrl : GITLAB_DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    // GitLab takes any username beside an access token over HTTPS; `oauth2` is the one it documents
    const basic = Buffer.from(`oauth2:${token}`).toString('base64');
    return {
      url: `${base}/${String(config.projectPath)}.git`,
      headers: { Authorization: `Basic ${basic}` },
    };
  },
  preRelayCredential({ config, secrets }) {
    return {
      username: 'oauth2',
      password: tokenOf(secrets, this.repositoryOf(config)),
      expiresAt: new Date(Date.now() + ASK_AGAIN_MS).toISOString(),
    };
  },
};
