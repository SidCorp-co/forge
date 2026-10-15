/**
 * Where the instance's App stands on GitHub as a person reads it on its row: whether any account can
 * install it, and the GitHub pages that change what it can reach.
 *
 * A private App installs only on its owner's account. GitHub answers `GET /apps/<slug>` without
 * credentials for a public App and 404 for a private one, so that answer is the whole test; one
 * GitHub did not give is `unknown`, never guessed either way.
 */

import { GITHUB_API_BASE } from './types.js';

const GITHUB_WEB = 'https://github.com';
const VISIBILITY_TIMEOUT_MS = 5000;
// unauthenticated reads share 60 an hour per address; a directory reload must not spend them
const VISIBILITY_TTL_MS = 5 * 60_000;

export type AppVisibility = 'public' | 'private' | 'unknown';

const seen = new Map<string, { visibility: AppVisibility; at: number }>();

/** Tests only: each case reads GitHub afresh. */
export function forgetAppVisibility(): void {
  seen.clear();
}

export async function readAppVisibility(
  slug: string,
  opts: { apiBaseUrl?: string; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<AppVisibility> {
  const now = opts.now ?? Date.now();
  const held = seen.get(slug);
  if (held && now - held.at < VISIBILITY_TTL_MS) return held.visibility;
  const api = (opts.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
  let visibility: AppVisibility = 'unknown';
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${api}/apps/${encodeURIComponent(slug)}`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(VISIBILITY_TIMEOUT_MS),
    });
    if (res.ok) visibility = 'public';
    else if (res.status === 404) visibility = 'private';
  } catch {
    // unreachable GitHub leaves it unknown, and nothing is remembered
    return 'unknown';
  }
  if (visibility !== 'unknown') seen.set(slug, { visibility, at: now });
  return visibility;
}

/** The App settings page where its owner makes it public. */
export function appAdvancedSettingsUrl(slug: string, owner: string, ownerIsOrg: boolean): string {
  const base = ownerIsOrg
    ? `${GITHUB_WEB}/organizations/${encodeURIComponent(owner)}/settings/apps`
    : `${GITHUB_WEB}/settings/apps`;
  return `${base}/${encodeURIComponent(slug)}/advanced`;
}

/** The installation's settings page, where the account it is on adds or removes repositories. */
export function installationSettingsUrl(
  installationId: number,
  account: string,
  accountIsOrg: boolean,
): string {
  return accountIsOrg
    ? `${GITHUB_WEB}/organizations/${encodeURIComponent(account)}/settings/installations/${installationId}`
    : `${GITHUB_WEB}/settings/installations/${installationId}`;
}
