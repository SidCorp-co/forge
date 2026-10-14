/**
 * The GitHub App manifest flow — what turns "connect GitHub" into one click.
 *
 * The operator's browser POSTs a manifest to GitHub, GitHub creates the App
 * and redirects back with a short-lived code, and converting that code yields
 * the App's id, private key and webhook secret: nothing is typed by hand.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { inboundWebhookUrl } from '../index.js';
import { APP_EVENTS, APP_PERMISSIONS } from './app-permissions.js';
import { anonymousOctokit, responseOf } from './octokit.js';

/**
 * As long as the code GitHub hands back lives: an hour. The state is signed when Connect is pressed
 * and read when GitHub returns, after the person has read GitHub's create page; a shorter state
 * refused a slow reader after GitHub had already made the App, and stranded it there (FB-128).
 */
export const STATE_TTL_MS = 60 * 60_000;

export interface ConnectState {
  projectId: string;
  userId: string;
  /** Org that will own the credential, when the operator chose an org-owned
   *  App. Absent = personal. The choice is made at connect time but spent in
   *  the callback, which sees nothing but this state. */
  orgId?: string;
  /** Where the flow began, so the install lands back there: the workspace Integrations page, or
   *  the project's settings when absent. */
  returnTo?: 'integrations';
  /** The connection the manifest callback created, carried through GitHub's install step. */
  connectionId?: string;
}

/**
 * A connect state as read back: genuine, forged, or genuine and past its hour. An expired one is
 * still told apart from a forged one, because only a state Forge signed for this person may have
 * its code spent to name the App it stranded.
 */
export type ConnectStateRead =
  | { ok: true; state: ConnectState }
  | { ok: false; why: 'invalid' }
  | { ok: false; why: 'expired'; state: ConnectState };

export function signConnectState(secret: string, state: ConnectState, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...state, exp: nowMs + STATE_TTL_MS })).toString(
    'base64url',
  );
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readConnectState(
  secret: string,
  token: string,
  nowMs = Date.now(),
): ConnectStateRead {
  const invalid = { ok: false as const, why: 'invalid' as const };
  const [body, mac] = token.split('.');
  if (!body || !mac) return invalid;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (expected.length !== mac.length) return invalid;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return invalid;

  let parsed: ConnectState & { exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return invalid;
  }
  if (typeof parsed.exp !== 'number' || !parsed.projectId || !parsed.userId) return invalid;
  const state: ConnectState = {
    projectId: parsed.projectId,
    userId: parsed.userId,
    ...(parsed.orgId ? { orgId: parsed.orgId } : {}),
    ...(parsed.returnTo === 'integrations' ? { returnTo: 'integrations' as const } : {}),
    ...(parsed.connectionId ? { connectionId: parsed.connectionId } : {}),
  };
  return parsed.exp < nowMs ? { ok: false, why: 'expired', state } : { ok: true, state };
}

/**
 * The manifest GitHub renders as the App it is about to create. `redirect_url`
 * receives the conversion code; `hook_attributes.url` is where deliveries land.
 */
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
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
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
  /** Who owns the App on GitHub: where its settings page lives. */
  owner?: { login: string; isOrg: boolean };
}

/** Exchange the one-time code for the App's credentials. The code is single-use. */
export async function convertManifestCode(args: {
  code: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<ConvertedApp> {
  let body: {
    id?: number;
    pem?: string;
    webhook_secret?: string;
    slug?: string;
    html_url?: string;
    owner?: { login?: string; type?: string };
  };
  try {
    body = (
      await anonymousOctokit(args).request({
        method: 'POST',
        url: `/app-manifests/${encodeURIComponent(args.code)}/conversions`,
      })
    ).data as typeof body;
  } catch (err) {
    const status = responseOf(err)?.status;
    if (status === undefined) throw err;
    throw new Error(`github: converting the manifest code returned HTTP ${status}`);
  }
  if (!body.id || !body.pem || !body.webhook_secret) {
    throw new Error('github: the manifest conversion returned an incomplete credential');
  }
  return {
    appId: String(body.id),
    privateKey: body.pem,
    webhookSecret: body.webhook_secret,
    ...(body.slug ? { slug: body.slug } : {}),
    ...(body.html_url ? { htmlUrl: body.html_url } : {}),
    ...(body.owner?.login
      ? { owner: { login: body.owner.login, isOrg: body.owner.type === 'Organization' } }
      : {}),
  };
}

/** Where a person deletes an App or makes it a new key: its own settings page when its name is known. */
export function appSettingsUrl(app?: Pick<ConvertedApp, 'slug' | 'owner'>): string {
  if (!app?.slug) return 'https://github.com/settings/apps';
  const slug = encodeURIComponent(app.slug);
  return app.owner?.isOrg
    ? `https://github.com/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;
}
