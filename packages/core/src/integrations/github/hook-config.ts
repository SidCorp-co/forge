/**
 * ISS-1140 — asking GitHub where it is calling, instead of assuming it is still where we put it.
 * `buildAppManifest` writes `hook_attributes.url` once and nothing read it back, so a URL wrong at
 * creation or changed on github.com afterwards was unknowable here. The read authenticates as the
 * App itself — the JWT, not an installation token — so it needs no installation permission.
 */

import { appOctokit, responseOf } from './octokit.js';

const HOOK_CONFIG_TIMEOUT_MS = 8000;

/** What GitHub answered about this App's webhook, or why it could not be asked. */
type AppHookConfig =
  | { readonly read: true; readonly url: string | null; readonly active: boolean | null }
  | { readonly read: false; readonly reason: string };

/**
 * A failure is returned rather than thrown: the caller is a health probe, and an exception would
 * abandon the repository verdict it already holds. An absent `active` is reported as `null` rather
 * than assumed `true`, because that assumption would turn an unknown into a green.
 */
export async function readAppHookConfig(args: {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AppHookConfig> {
  let body: { url?: unknown; active?: unknown };
  try {
    body = (
      await appOctokit(args).request({
        method: 'GET',
        url: '/app/hook/config',
        request: { signal: AbortSignal.timeout(HOOK_CONFIG_TIMEOUT_MS) },
      })
    ).data as typeof body;
  } catch (err) {
    const status = responseOf(err)?.status;
    if (status === 401) {
      return {
        read: false,
        reason:
          "GitHub rejected the App JWT when asked for this App's webhook configuration — check the App id and private key",
      };
    }
    if (status !== undefined) {
      return {
        read: false,
        reason: `asking GitHub for this App's webhook configuration returned HTTP ${status}`,
      };
    }
    return {
      read: false,
      reason: `GitHub could not be asked for this App's webhook configuration: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!body || typeof body !== 'object') {
    return { read: false, reason: "GitHub's webhook configuration was not JSON" };
  }
  return {
    read: true,
    url: typeof body.url === 'string' ? body.url : null,
    active: typeof body.active === 'boolean' ? body.active : null,
  };
}
