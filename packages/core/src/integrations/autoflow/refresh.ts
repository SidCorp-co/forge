/**
 * Keeps an Autoflow connection's access token alive from its rotating refresh token.
 *
 * The platform (`backend-go/internal/oauth`) issues a 12-hour access token (`sat_…`) and a 90-day
 * sliding refresh token (`srt_…`). A refresh is `POST <platform>/oauth/token`, form-encoded
 * `grant_type=refresh_token&client_id=<mcpc_…>&refresh_token=<srt_…>`, answering
 * `{access_token, refresh_token, expires_in}`. It SPENDS the presented refresh token: presenting a
 * spent one outside the platform's short reuse grace revokes the whole connection. So every
 * refresh runs under the connection row's lock and re-reads the stored pair first — a second
 * caller that waited on the lock finds the rotation already done and uses its result, and the
 * chain is never presented twice.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationConnections } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { decryptJson, encryptJson } from '../vault.js';
import { autoflowBaseUrl } from './endpoints.js';
import type { AutoflowSecrets } from './types.js';

/** Forge's own calls (healthcheck, storefront target) refresh a token with less than this left. */
export const AUTOFLOW_REFRESH_MARGIN_MS = 30 * 60_000;
/** A run is handed a token good for at least this long, or one is refreshed for it. */
export const AUTOFLOW_INJECTION_MIN_LIFETIME_MS = 6 * 60 * 60_000;
const REFRESH_TIMEOUT_MS = 10_000;

export type AutoflowFreshToken =
  | { kind: 'ok'; secrets: AutoflowSecrets; rotated: boolean }
  /** The connection cannot produce a token without a new sign-in; recorded on its health. */
  | { kind: 'needs_reauth'; reason: string }
  /** The refresh could not be attempted to an answer (network, 5xx, rate limit). Not recorded as
   *  needs-re-auth; `secrets` is the stored pair where its access token is still unexpired. */
  | { kind: 'unavailable'; reason: string; secrets: AutoflowSecrets | null };

type RefreshAnswer =
  | { kind: 'ok'; accessToken: string; refreshToken: string; expiresInSec: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'transient'; reason: string };

/** The platform's token endpoint, on the origin that serves `/oauth/*`. */
export function autoflowTokenUrl(config: { baseUrl?: unknown }): string {
  return `${autoflowBaseUrl(config).replace(/\/graphql$/, '')}/oauth/token`;
}

async function requestRefresh(
  url: string,
  clientId: string,
  refreshToken: string,
): Promise<RefreshAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }).toString(),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    if (res.ok) {
      const { access_token, refresh_token, expires_in } = body;
      if (
        typeof access_token !== 'string' ||
        !access_token.startsWith('sat_') ||
        typeof refresh_token !== 'string' ||
        !refresh_token.startsWith('srt_') ||
        typeof expires_in !== 'number' ||
        expires_in <= 0
      ) {
        // The presented token is spent either way; a body we cannot store is a dead chain.
        return { kind: 'refused', reason: 'malformed_token_response' };
      }
      return {
        kind: 'ok',
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresInSec: expires_in,
      };
    }
    const code = typeof body.error === 'string' ? body.error : `http_${res.status}`;
    const description =
      typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
    // 400 invalid_grant / invalid_request and 401 invalid_client are the platform refusing THIS
    // refresh token or client for good; 429 slow_down and 5xx are worth another attempt later.
    if (res.status === 429 || res.status >= 500) {
      return { kind: 'transient', reason: `${code}${description}` };
    }
    return { kind: 'refused', reason: `${code}${description}` };
  } catch (err) {
    return { kind: 'transient', reason: `unreachable: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

function expiresWithin(secrets: AutoflowSecrets, ms: number, now: number): boolean | null {
  if (!secrets.accessTokenExpiresAt) return null;
  const at = Date.parse(secrets.accessTokenExpiresAt);
  return Number.isNaN(at) ? null : at - now < ms;
}

function stillUnexpired(secrets: AutoflowSecrets, now: number): boolean {
  const within = expiresWithin(secrets, 0, now);
  return within === null ? true : !within;
}

/** The sentence a needs-re-auth connection carries on its card. */
export function reauthDetail(reason: string, baseUrl: string): string {
  return `Autoflow refresh refused (${reason}); the token chain is dead and nothing will retry it — sign in again at ${baseUrl} through an MCP client and store the new access token, refresh token and client id`;
}

/**
 * The connection's access token, refreshed and persisted first when it expires within
 * `minLifetimeMs` or when `refusedToken` (the token a call was just refused with) is still the one
 * stored. Holds the connection row's lock across the refresh, so concurrent callers rotate the
 * chain exactly once.
 */
export async function ensureFreshAutoflowToken(opts: {
  connectionId: string;
  config: Record<string, unknown>;
  minLifetimeMs: number;
  refusedToken?: string;
}): Promise<AutoflowFreshToken> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ secretsEnc: integrationConnections.secretsEnc })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, opts.connectionId))
      .for('update');
    if (!row?.secretsEnc) return { kind: 'needs_reauth', reason: 'no_credential' };
    const secrets = decryptJson<AutoflowSecrets>(row.secretsEnc);
    const now = Date.now();

    const due =
      opts.refusedToken !== undefined
        ? secrets.accessToken === opts.refusedToken
        : (expiresWithin(secrets, opts.minLifetimeMs, now) ??
          // An expiry nobody recorded is learned by refreshing, where a refresh token exists.
          Boolean(secrets.refreshToken));
    if (!due) return { kind: 'ok', secrets, rotated: false };

    if (!secrets.refreshToken || !secrets.clientId) {
      if (opts.refusedToken === undefined && stillUnexpired(secrets, now)) {
        return { kind: 'ok', secrets, rotated: false };
      }
      return {
        kind: 'needs_reauth',
        reason: secrets.refreshRefusedReason
          ? `refresh_refused: ${secrets.refreshRefusedReason}`
          : 'no_refresh_token',
      };
    }

    const baseUrl = autoflowBaseUrl(opts.config);
    const answer = await requestRefresh(
      autoflowTokenUrl(opts.config),
      secrets.clientId,
      secrets.refreshToken,
    );

    if (answer.kind === 'transient') {
      logger.warn(
        { connectionId: opts.connectionId, reason: answer.reason },
        'autoflow: refresh not answered, keeping the stored token',
      );
      return {
        kind: 'unavailable',
        reason: answer.reason,
        secrets: opts.refusedToken === undefined && stillUnexpired(secrets, now) ? secrets : null,
      };
    }

    if (answer.kind === 'refused') {
      const { refreshToken: _dead, ...rest } = secrets;
      const next: AutoflowSecrets = {
        ...rest,
        refreshRefusedAt: new Date(now).toISOString(),
        refreshRefusedReason: answer.reason,
      };
      await tx
        .update(integrationConnections)
        .set({
          secretsEnc: encryptJson(next),
          lastHealthStatus: 'needs_reauth',
          lastHealthDetail: reauthDetail(answer.reason, baseUrl),
          lastHealthAt: new Date(now),
          updatedAt: new Date(now),
        })
        .where(eq(integrationConnections.id, opts.connectionId));
      logger.warn(
        { connectionId: opts.connectionId, reason: answer.reason },
        'autoflow: refresh refused, connection needs re-auth',
      );
      return { kind: 'needs_reauth', reason: `refresh_refused: ${answer.reason}` };
    }

    const {
      refreshRefusedAt: _at,
      refreshRefusedReason: _why,
      previousAccessToken: _prev,
      previousTokenExpiresAt: _prevAt,
      ...kept
    } = secrets;
    const oldStillValid = stillUnexpired(secrets, now) && secrets.accessTokenExpiresAt;
    const next: AutoflowSecrets = {
      ...kept,
      accessToken: answer.accessToken,
      accessTokenExpiresAt: new Date(now + answer.expiresInSec * 1000).toISOString(),
      refreshToken: answer.refreshToken,
      // The replaced token is still admitted until its own expiry; a run handed it keeps working.
      ...(oldStillValid
        ? {
            previousAccessToken: secrets.accessToken,
            previousTokenExpiresAt: secrets.accessTokenExpiresAt,
          }
        : {}),
    };
    await tx
      .update(integrationConnections)
      .set({ secretsEnc: encryptJson(next), updatedAt: new Date(now) })
      .where(eq(integrationConnections.id, opts.connectionId));
    return { kind: 'ok', secrets: next, rotated: true };
  });
}
