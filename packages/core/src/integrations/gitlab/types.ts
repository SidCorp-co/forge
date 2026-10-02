export interface GitLabConfig extends Record<string, unknown> {
  baseUrl?: string;
  projectPath?: string;
  projectId?: number;
}

export interface GitLabSecrets extends Record<string, unknown> {
  token?: string;
  previousToken?: string;
  previousTokenExpiresAt?: string;
}

export const GITLAB_DEFAULT_BASE_URL = 'https://gitlab.com';

/** The host a GitLab connection's base URL serves, as `source.git.repository` spells hosts. */
export function gitlabHostOf(config: Record<string, unknown>): string {
  const base = typeof config.baseUrl === 'string' ? config.baseUrl : GITLAB_DEFAULT_BASE_URL;
  return new URL(base).host.toLowerCase();
}
