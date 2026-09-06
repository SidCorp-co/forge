/**
 * GitHub provider credential shape.
 *
 * The credential is a GitHub App, not a pasted token: the operator authorizes
 * once and GitHub hands back `id` / `pem` / `webhook_secret` through the app
 * manifest flow. `installationId` is what the authorization produces per
 * account, so it is binding tier alongside the repository; the App itself is
 * connection tier because one App serves every installation.
 */

export interface GitHubConfig extends Record<string, unknown> {
  installationId?: number;
  owner?: string;
  repo?: string;
  /** GitHub Enterprise only; absent means api.github.com. */
  apiBaseUrl?: string;
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
