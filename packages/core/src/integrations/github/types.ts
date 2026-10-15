export interface GitHubConfig extends Record<string, unknown> {
  installationId?: number;
  owner?: string;
  repo?: string;
  apiBaseUrl?: string;
  /** The instance App's own name and owner on GitHub, on its connection. */
  appSlug?: string;
  appOwner?: string;
  appOwnerIsOrg?: boolean;
}

export interface GitHubSecrets extends Record<string, unknown> {
  appId?: string;
  privateKey?: string;
  previousPrivateKey?: string;
  previousTokenExpiresAt?: string;
  /** The App's own webhook secret, as returned by the manifest conversion. */
  webhookSecret?: string;
  /** The webhook secret a rotation replaced; it verifies until a delivery verifies with the new one. */
  previousWebhookSecret?: string;
  /** The App's OAuth client, spent to prove an installation is the installer's own. */
  clientId?: string;
  clientSecret?: string;
}

export const GITHUB_API_BASE = 'https://api.github.com';

export interface HeadersLike {
  get(name: string): string | null;
}
