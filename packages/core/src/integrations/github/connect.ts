/**
 * The GitHub App manifest flow — what turns "connect GitHub" into one click.
 *
 * The operator's browser POSTs a manifest to GitHub, GitHub creates the App
 * and redirects back with a short-lived code, and converting that code yields
 * the App's id, private key and webhook secret. Nothing is typed by hand, so
 * nothing can be mistyped, and Forge never asks anyone for a token.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { GITHUB_API_BASE } from './types.js';

const STATE_TTL_MS = 10 * 60_000;

export interface ConnectState {
  projectId: string;
  userId: string;
  /** Org that will own the credential, when the operator chose an org-owned
   *  App. Absent = personal. The choice is made at connect time but spent in
   *  the callback, which sees nothing but this state. */
  orgId?: string;
}

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
  return {
    projectId: parsed.projectId,
    userId: parsed.userId,
    ...(parsed.orgId ? { orgId: parsed.orgId } : {}),
  };
}

/**
 * ONE resolution, read by the route that builds the manifest and by the probe that checks what
 * GitHub holds: a second copy of this chain would let the two disagree, and a binding would be
 * reported broken against a URL nobody wrote. Null rather than a throw, because one caller is a
 * health probe where a missing origin is a fact to report.
 */
export function resolveApiBaseUrl(): string | null {
  const base = env.PUBLIC_API_BASE_URL ?? env.OAUTH_REDIRECT_BASE ?? process.env.APP_BASE_URL;
  return base ? base.replace(/\/+$/, '') : null;
}

/**
 * ONE expression for two callers that must never disagree: the manifest telling GitHub where to
 * call, and the probe comparing GitHub's answer to it. Two spellings is a drift nobody would see
 * until a binding reported a mismatch against itself (ISS-1140).
 */
export function inboundWebhookUrl(apiBaseUrl: string, projectSlug: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/webhooks/in/${projectSlug}`;
}

/**
 * The manifest GitHub renders as the App it is about to create. `redirect_url`
 * receives the conversion code; `hook_attributes.url` is where deliveries land.
 */
// cm:edge lockstep -> packages/core/src/integrations/github/app-permissions.ts — what needs them
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
    hook_attributes: { url: inboundWebhookUrl(api, args.projectSlug), active: true },
    redirect_url: `${api}/api/integrations/github/manifest-callback`,
    setup_url: `${api}/api/integrations/github/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      actions: 'read',
      administration: 'read',
      checks: 'write',
      contents: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
    },
    default_events: [
      'issues',
      'pull_request',
      'pull_request_review',
      'check_run',
      'push',
      'workflow_run',
    ],
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
