/**
 * The one way core reaches GitHub as an App: `@octokit/auth-app` signs the App JWT and mints and
 * caches installation tokens, the retry plugin re-sends a GET that met a 5xx, and the throttling
 * plugin spaces writes per installation and waits out a short rate limit.
 *
 * Two hops, not interchangeable: the App JWT proves which App this is and is what `/app/*` routes
 * take; every repository call carries the installation token that JWT mints. auth-app picks the
 * right one per route.
 */

import { createHash } from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/core';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { logger } from '../../observability/logger.js';
import { GITHUB_API_BASE, type HeadersLike } from './types.js';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RATE_LIMIT_WAIT_S = 5;

const GitHubApp = Octokit.plugin(retry, throttling);
export type GitHubOctokit = InstanceType<typeof GitHubApp>;

export class GitHubAuthError extends Error {
  readonly status: number;
  readonly headers: HeadersLike | null;
  constructor(status: number, message: string, headers: HeadersLike | null = null) {
    super(message);
    this.name = 'GitHubAuthError';
    this.status = status;
    this.headers = headers;
  }
}

interface AppCredential {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

const octokitLog = {
  debug: (msg: string) => logger.debug({ provider: 'github' }, msg),
  info: (msg: string) => logger.info({ provider: 'github' }, msg),
  warn: (msg: string) => logger.warn({ provider: 'github' }, msg),
  error: (msg: string) => logger.error({ provider: 'github' }, msg),
};

/** A request with no signal of its own is still bounded: the token mint inside auth-app is one. */
function boundedFetch(inner: typeof fetch): typeof fetch {
  return (input, init) =>
    inner(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
}

const shortWait = (retryAfter: number, retryCount: number) =>
  retryCount === 0 && retryAfter <= MAX_RATE_LIMIT_WAIT_S;

function build(cred: AppCredential, installationId: number | null): GitHubOctokit {
  return new GitHubApp({
    baseUrl: (cred.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, ''),
    authStrategy: createAppAuth,
    auth: {
      appId: cred.appId,
      privateKey: cred.privateKey,
      ...(installationId === null ? {} : { installationId }),
    },
    request: { fetch: boundedFetch(cred.fetchImpl ?? fetch) },
    log: octokitLog,
    retry: { retries: 2, retryAfterBaseValue: 500 },
    throttle: {
      id: `${cred.appId}:${installationId ?? 'app'}`,
      onRateLimit: (
        retryAfter: number,
        options: { method?: string; url?: string },
        _o: unknown,
        retryCount: number,
      ) => {
        octokitLog.warn(
          `rate limited on ${options.method} ${options.url}, reset in ${retryAfter}s`,
        );
        return shortWait(retryAfter, retryCount);
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        options: { method?: string; url?: string },
        _o: unknown,
        retryCount: number,
      ) => {
        octokitLog.warn(
          `secondary rate limit on ${options.method} ${options.url}, retry after ${retryAfter}s`,
        );
        return shortWait(retryAfter, retryCount);
      },
    },
  });
}

const instances = new Map<string, GitHubOctokit>();

/**
 * One client per App, key and installation, kept so auth-app's token cache and the throttling
 * queue outlive a single call. A rotated key is a different key, so it never reuses a token the
 * old one minted. A test's own fetch builds an uncached client.
 */
function cached(cred: AppCredential, installationId: number | null): GitHubOctokit {
  if (cred.fetchImpl) return build(cred, installationId);
  const fingerprint = createHash('sha256').update(cred.privateKey).digest('hex').slice(0, 16);
  const key = `${cred.apiBaseUrl ?? GITHUB_API_BASE}|${cred.appId}|${fingerprint}|${installationId ?? 'app'}`;
  let hit = instances.get(key);
  if (!hit) {
    hit = build(cred, installationId);
    instances.set(key, hit);
  }
  return hit;
}

/** As the App itself: only `/app/*` routes, which spend no installation permission. */
export const appOctokit = (cred: AppCredential): GitHubOctokit => cached(cred, null);

/** As one installation: repository routes carry its token, `/app/*` routes the App JWT. */
export const installationOctokit = (
  cred: AppCredential & { installationId: number },
): GitHubOctokit => cached(cred, cred.installationId);

/** With no credential at all: the manifest conversion, whose one-time code is its own proof. */
export const anonymousOctokit = (args: { apiBaseUrl?: string; fetchImpl?: typeof fetch }) =>
  new Octokit({
    baseUrl: (args.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, ''),
    request: { fetch: boundedFetch(args.fetchImpl ?? fetch) },
    log: octokitLog,
  });

/** The status and headers of a GitHub answer carried by a thrown octokit error, or null. */
export function responseOf(
  err: unknown,
): { status: number; headers: HeadersLike; data: unknown } | null {
  const response = (
    err as { response?: { status?: number; headers?: Record<string, unknown>; data?: unknown } }
  )?.response;
  if (!response || typeof response.status !== 'number') return null;
  const raw = response.headers ?? {};
  return {
    status: response.status,
    headers: {
      get: (name) => {
        const v = raw[name.toLowerCase()];
        return v === undefined || v === null ? null : String(v);
      },
    },
    data: response.data,
  };
}

/** Whether a thrown value is a timeout or abort, wrapped by octokit or not. */
export function isTimeout(err: unknown): boolean {
  const named = (e: unknown) =>
    e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return named(err) || named((err as { cause?: unknown })?.cause);
}

/** The sentence a refused token mint is reported with, whichever door met it. */
function mintRefusal(status: number, installationId: number): string {
  if (status === 401) return 'GitHub rejected the App JWT — check the App id and private key';
  if (status === 404)
    return `installation ${installationId} does not exist for this App — it was removed, or the App was never installed on that account`;
  return `minting an installation token returned HTTP ${status}`;
}

/**
 * Mint (or reuse) the installation token. auth-app caches it for a minute less than GitHub's hour.
 * The expiry is what a git credential helper plans around: git asks per invocation, so a long job
 * outlives any single token.
 */
export async function mintInstallationToken(
  cred: AppCredential & { installationId: number },
): Promise<{ token: string; expiresAt: number }> {
  let auth: { token: string; expiresAt?: string };
  try {
    auth = (await installationOctokit(cred).auth({ type: 'installation' })) as {
      token: string;
      expiresAt?: string;
    };
  } catch (err) {
    const answered = responseOf(err);
    if (answered) {
      throw new GitHubAuthError(
        answered.status,
        mintRefusal(answered.status, cred.installationId),
        answered.headers,
      );
    }
    throw err;
  }
  const expiresAt = auth.expiresAt ? Date.parse(auth.expiresAt) : Date.now() + 3600_000;
  return { token: auth.token, expiresAt };
}
