import type { StorefrontTargetArgs } from '../index.js';
import { autoflowGql } from './client.js';
import { autoflowGraphqlUrl } from './endpoints.js';
import { AUTOFLOW_REFRESH_MARGIN_MS, ensureFreshAutoflowToken } from './refresh.js';
import type { AutoflowConfig, AutoflowSecrets } from './types.js';

const LIVE_READ_TIMEOUT_MS = 5_000;

export type AutoflowLiveRead =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export async function autoflowLiveRead(
  args: StorefrontTargetArgs,
  config: AutoflowConfig,
  query: string,
): Promise<AutoflowLiveRead> {
  let stored: Partial<AutoflowSecrets>;
  try {
    stored = args.readSecrets() as Partial<AutoflowSecrets>;
  } catch (err) {
    return { ok: false, reason: `secrets_unreadable: ${(err as Error).message}` };
  }
  if (!stored.accessToken) return { ok: false, reason: 'no_credential' };
  try {
    const fresh = await ensureFreshAutoflowToken({
      connectionId: args.connectionId,
      config,
      minLifetimeMs: AUTOFLOW_REFRESH_MARGIN_MS,
    });
    if (fresh.kind === 'needs_reauth') return { ok: false, reason: fresh.reason };
    const token = fresh.secrets?.accessToken ?? stored.accessToken;
    const url = autoflowGraphqlUrl(config);
    let res = await autoflowGql(url, token, query, LIVE_READ_TIMEOUT_MS);
    if (res.kind === 'unauthorized') {
      const retry = await ensureFreshAutoflowToken({
        connectionId: args.connectionId,
        config,
        minLifetimeMs: AUTOFLOW_REFRESH_MARGIN_MS,
        refusedToken: token,
      });
      if (retry.kind === 'needs_reauth') return { ok: false, reason: retry.reason };
      if (retry.kind === 'ok' && retry.secrets.accessToken !== token) {
        res = await autoflowGql(url, retry.secrets.accessToken, query, LIVE_READ_TIMEOUT_MS);
      }
    }
    if (res.kind === 'ok') return { ok: true, data: res.data };
    if (res.kind === 'unauthorized') return { ok: false, reason: `unauthorized: ${res.message}` };
    if (res.kind === 'http-error') return { ok: false, reason: `http_${res.status}` };
    return { ok: false, reason: `graphql_error: ${res.message}` };
  } catch (err) {
    return { ok: false, reason: `unreachable: ${(err as Error).message}` };
  }
}
