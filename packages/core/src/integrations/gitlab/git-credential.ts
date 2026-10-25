import type { RelayedGitCredential } from '../index.js';
import { GITLAB_DEFAULT_BASE_URL, gitlabHostOf } from './types.js';

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
    const token = typeof secrets.token === 'string' ? secrets.token : '';
    if (!token)
      throw new Error(
        `the connection behind ${this.repositoryOf(config)} holds no GitLab access token`,
      );
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
};
