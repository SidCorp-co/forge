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

/**
 * The part of a `Response`'s headers a refusal is built from.
 *
 * Structural rather than `Headers`, so a test can hand one over without a fetch
 * polyfill — and so nothing on the refusal path can reach a header this narrow
 * shape does not offer.
 */
export interface HeadersLike {
  get(name: string): string | null;
}
