/**
 * GitHub provider config + secrets, as stored on the connection/binding pair.
 *
 * `owner`/`repo` are binding tier (one org credential, one repo per project);
 * `apiBaseUrl` is connection tier and only set for GitHub Enterprise.
 */

export interface GitHubConfig extends Record<string, unknown> {
  owner?: string;
  repo?: string;
  apiBaseUrl?: string;
}

export interface GitHubSecrets extends Record<string, unknown> {
  token?: string;
  previousToken?: string;
  previousTokenExpiresAt?: string;
}

export const GITHUB_API_BASE = 'https://api.github.com';
