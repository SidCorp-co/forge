export interface GitHubConfig extends Record<string, unknown> {
  installationId?: number;
  owner?: string;
  repo?: string;
  apiBaseUrl?: string;
  /** ISS-1072 — `false` turns off the `forge/issue-contract` check run. Absent is on. */
  contractCheck?: boolean;
}

export interface GitHubSecrets extends Record<string, unknown> {
  appId?: string;
  privateKey?: string;
  previousPrivateKey?: string;
  previousTokenExpiresAt?: string;
  /** The App's own webhook secret, as returned by the manifest conversion. */
  webhookSecret?: string;
}

export const GITHUB_API_BASE = 'https://api.github.com';

export interface HeadersLike {
  get(name: string): string | null;
}
