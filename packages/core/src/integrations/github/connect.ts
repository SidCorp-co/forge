/**
 * The GitHub App manifest flow — what turns "connect GitHub" into one click.
 *
 * The operator's browser POSTs a manifest to GitHub, GitHub creates the App
 * and redirects back with a short-lived code, and converting that code yields
 * the App's id, private key, webhook secret and OAuth client: nothing is typed by hand.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { APP_EVENTS, APP_PERMISSIONS } from './app-permissions.js';
import { anonymousOctokit, responseOf } from './octokit.js';

/**
 * As long as the code GitHub hands back lives: an hour. The state is signed when Connect is pressed
 * and read when GitHub returns, after the person has read GitHub's create page; a shorter state
 * refused a slow reader after GitHub had already made the App, and stranded it there (FB-128).
 */
export const STATE_TTL_MS = 60 * 60_000;

export interface ConnectState {
  userId: string;
  /** The project the flow began on, where it began on one: its return lands back there. */
  projectId?: string;
  /** The Forge org an installation made in this flow is recorded for. Chosen when Connect is
   *  pressed and spent on the return, which sees nothing but this state. */
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
  if (typeof parsed.exp !== 'number' || !parsed.userId) return invalid;
  const state: ConnectState = {
    userId: parsed.userId,
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    ...(parsed.orgId ? { orgId: parsed.orgId } : {}),
    ...(parsed.returnTo === 'integrations' ? { returnTo: 'integrations' as const } : {}),
    ...(parsed.connectionId ? { connectionId: parsed.connectionId } : {}),
  };
  return parsed.exp < nowMs ? { ok: false, why: 'expired', state } : { ok: true, state };
}

/** The App-wide door every installation's deliveries arrive at, built on the API's public origin. */
export function appWebhookUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/webhooks/github/app`;
}

/**
 * The manifest GitHub renders as the instance's App. It is public, so any account can install it,
 * and it asks the installer for OAuth on install, so the return carries a code that proves which
 * installations they can reach: GitHub then sends the browser to `callback_urls`, not to
 * `setup_url`. `redirect_url` receives the conversion code. Both are built on `returnBaseUrl`, the
 * origin that carries the person's session; `hook_attributes.url` is where GitHub's servers deliver.
 */
export function buildAppManifest(args: {
  appName: string;
  webBaseUrl: string;
  apiBaseUrl: string;
  returnBaseUrl: string;
}): Record<string, unknown> {
  const web = args.webBaseUrl.replace(/\/+$/, '');
  const back = args.returnBaseUrl.replace(/\/+$/, '');
  const installed = `${back}/api/integrations/github/installed`;
  return {
    name: args.appName,
    url: web,
    hook_attributes: { url: appWebhookUrl(args.apiBaseUrl), active: true },
    redirect_url: `${back}/api/integrations/github/manifest-callback`,
    callback_urls: [installed],
    request_oauth_on_install: true,
    setup_url: installed,
    setup_on_update: true,
    public: true,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
  };
}

/** Where the manifest is posted: the operator's own account owns the instance's App. */
export const MANIFEST_POST_URL = 'https://github.com/settings/apps/new';

export interface ConvertedApp {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  clientId?: string;
  clientSecret?: string;
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
    client_id?: string;
    client_secret?: string;
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
    ...(body.client_id ? { clientId: body.client_id } : {}),
    ...(body.client_secret ? { clientSecret: body.client_secret } : {}),
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
