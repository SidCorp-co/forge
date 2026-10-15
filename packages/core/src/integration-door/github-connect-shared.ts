/**
 * What the GitHub connect routes share: where a return lands, the secrets and origins a connect is
 * signed and sent back with, and whom a person is told to ask.
 */

import type { GitHubConnectStrand, IntegrationRefusalCode } from '@forge/contracts/integrations';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type ConnectState,
  type ConvertedApp,
  convertManifestCode,
} from '../integrations/github/index.js';
import { resolveApiBaseUrl } from '../integrations/index.js';
import { logger } from '../lib/logger.js';
import { refuser } from '../lib/refusal.js';
import { platformAdminNames } from '../middleware/require-admin.js';
import { projectOrgHead } from '../projects/index.js';

export const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

/** What a stranded App can be named by: its slug and owner, read when its code was spent. */
export type StrandedApp = Pick<ConvertedApp, 'slug' | 'owner'>;

/**
 * The web Integrations page, naming why GitHub's return could not finish and, where it is known,
 * the App GitHub made: `?connect=<cause>&app=<slug>&appOwner=<login>&appOrg=1`.
 */
export function strandedAt(
  c: Context,
  cause: GitHubConnectStrand,
  app?: StrandedApp | null,
): Response {
  const q = new URLSearchParams({ connect: cause });
  if (app?.slug) q.set('app', app.slug);
  if (app?.owner) {
    q.set('appOwner', app.owner.login);
    if (app.owner.isOrg) q.set('appOrg', '1');
  }
  return c.redirect(`${webBaseUrl()}/integrations?${q.toString()}`);
}

/**
 * Spend a genuine, own return's code only to learn which App GitHub made, and drop the key it
 * comes with: the person it was made for may delete it or mint it a new key, but Forge was never
 * allowed to keep this one. Null when GitHub will not convert it.
 */
export async function nameStrandedApp(code: string): Promise<StrandedApp | null> {
  try {
    const { slug, owner } = await convertManifestCode({ code });
    logger.info({ slug }, 'github: named a stranded App; its key was not kept');
    return { ...(slug ? { slug } : {}), ...(owner ? { owner } : {}) };
  } catch (err) {
    logger.warn({ err }, 'github: a stranded App could not be named');
    return null;
  }
}

/** Where a finished connect lands: the page it began on. */
/**
 * Where a finished connect lands: Integrations to bind, or the connections section of the project
 * it was started from, addressed by the slug the web routes on.
 */
export async function finishedAt(
  state: Pick<ConnectState, 'returnTo' | 'projectId'>,
  connectionId: string,
): Promise<string> {
  const bindAt = `${webBaseUrl()}/integrations?bind=${encodeURIComponent(connectionId)}`;
  if (state.returnTo === 'integrations' || !state.projectId) return bindAt;
  const project = await projectOrgHead(state.projectId);
  if (!project) return bindAt;
  return `${webBaseUrl()}/projects/${encodeURIComponent(project.slug)}/settings?tab=connections#integrations`;
}

export function stateSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new HTTPException(500, { message: 'JWT_SECRET is not configured' });
  return secret;
}

export function webBaseUrl(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) throw new HTTPException(500, { message: 'APP_BASE_URL is not configured' });
  return base;
}

export function apiBaseUrl(): string {
  const base = resolveApiBaseUrl();
  if (!base) throw new HTTPException(500, { message: 'APP_BASE_URL is not configured' });
  return base;
}

/** The public origin this request reached core at, as the proxy in front of core reports it. */
export function reachedOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost) url.host = forwardedHost;
  return url.origin;
}

/**
 * Where GitHub sends the browser back after creating and installing the App: the origin this
 * request reached core at, when it is one this core is configured to answer on — the API's own
 * (PUBLIC_API_BASE_URL) or the web's (APP_BASE_URL, where the web serves `/api` in front of core).
 * This request proves that origin routes `/api` to core, and it is the origin the person's session
 * rides on, so the return carries the session the callbacks admit. Insisting on the API's origin
 * refused every connect begun on a web that proxies `/api`, which is how forge-dev is served.
 */
export function browserReturnOrigin(c: Context, api: string): string {
  const reached = reachedOrigin(c);
  const configured = [api, process.env.APP_BASE_URL]
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .map((u) => new URL(u).origin);
  if (configured.includes(reached)) return reached;
  throw new HTTPException(500, {
    message:
      `This request reached core at ${reached}, which is not an origin this core is configured to answer on ` +
      `(${configured.join(', ')}). GitHub sends the browser back to the origin the request came from, so open ` +
      'Forge at one of those, or set PUBLIC_API_BASE_URL to the origin this core is served at.',
  });
}

/** Who a person is told to ask for what only an operator of this Forge may do. */
export async function askAnOperator(): Promise<string> {
  const names = await platformAdminNames();
  return names.length > 0
    ? `Ask a Forge operator to connect GitHub: ${names.join(', ')}.`
    : 'Ask a Forge operator to connect GitHub: this Forge names none in ADMIN_EMAILS.';
}

/** The instance's name on GitHub: the host it is served at. */
export function instanceAppName(): string {
  return `Forge — ${new URL(webBaseUrl()).host}`;
}
