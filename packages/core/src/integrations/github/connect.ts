/**
 * The GitHub App manifest flow — what turns "connect GitHub" into one click.
 *
 * The operator's browser POSTs a manifest to GitHub, GitHub creates the App
 * and redirects back with a short-lived code, and converting that code yields
 * the App's id, private key and webhook secret. Nothing is typed by hand, so
 * nothing can be mistyped, and Forge never asks anyone for a token.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GITHUB_API_BASE } from './types.js';

const STATE_TTL_MS = 10 * 60_000;

export interface ConnectState {
  projectId: string;
  userId: string;
  environment: string;
}

// cm:guard the state carries the USER and is checked against the session on the way back — without that, the callback is a CSRF hole: an attacker who gets a signed state for their own App can have a victim's browser convert it and bind the attacker's App to the victim's project.
export function signConnectState(secret: string, state: ConnectState, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...state, exp: nowMs + STATE_TTL_MS })).toString(
    'base64url',
  );
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyConnectState(
  secret: string,
  token: string,
  nowMs = Date.now(),
): ConnectState | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (expected.length !== mac.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;

  let parsed: ConnectState & { exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed.exp !== 'number' || parsed.exp < nowMs) return null;
  if (!parsed.projectId || !parsed.userId) return null;
  return { projectId: parsed.projectId, userId: parsed.userId, environment: parsed.environment };
}

/**
 * The manifest GitHub renders as the App it is about to create. `redirect_url`
 * receives the conversion code; `hook_attributes.url` is where deliveries land.
 */
// cm:edge contract -> packages/core/src/webhooks/inbound-routes.ts — `hook_attributes.url` must be the `/api/webhooks/in/:slug` this core actually serves. GitHub stores it ON THE APP at creation time, so a path changed here after an App exists does not move that App's deliveries and they keep arriving at the old URL until someone edits the App by hand.
// cm:guard three of these four URLs are served by CORE and take `apiBaseUrl`; only `url` is the web app. Building them all from APP_BASE_URL is what shipped on 2026-09-06 and it 404s every one of them on a split-origin deploy — the redirect visibly, at the moment the operator has already created the App, and `hook_attributes` SILENTLY forever after.
export function buildAppManifest(args: {
  appName: string;
  webBaseUrl: string;
  apiBaseUrl: string;
  projectSlug: string;
}): Record<string, unknown> {
  const web = args.webBaseUrl.replace(/\/+$/, '');
  const api = args.apiBaseUrl.replace(/\/+$/, '');
  return {
    name: args.appName,
    url: web,
    hook_attributes: { url: `${api}/api/webhooks/in/${args.projectSlug}`, active: true },
    redirect_url: `${api}/api/integrations/github/manifest-callback`,
    setup_url: `${api}/api/integrations/github/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: 'read',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
      checks: 'read',
    },
    default_events: ['issues', 'pull_request', 'pull_request_review', 'check_run', 'push'],
  };
}

export function manifestPostUrl(owner?: string | null): string {
  return owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

export interface ConvertedApp {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  slug?: string;
  htmlUrl?: string;
}

/** Exchange the one-time code for the App's credentials. The code is single-use. */
export async function convertManifestCode(args: {
  code: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<ConvertedApp> {
  const base = (args.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(`${base}/app-manifests/${encodeURIComponent(args.code)}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`github: converting the manifest code returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    id?: number;
    pem?: string;
    webhook_secret?: string;
    slug?: string;
    html_url?: string;
  };
  // cm:guard all three or none — a connection holding an appId with no key, or a key with no webhook secret, is an authorization that half-happened. It would pass every schema and then fail at the first call with a message about the wrong thing, so refuse it here where the cause is still visible.
  if (!body.id || !body.pem || !body.webhook_secret) {
    throw new Error('github: the manifest conversion returned an incomplete credential');
  }
  return {
    appId: String(body.id),
    privateKey: body.pem,
    webhookSecret: body.webhook_secret,
    ...(body.slug ? { slug: body.slug } : {}),
    ...(body.html_url ? { htmlUrl: body.html_url } : {}),
  };
}
