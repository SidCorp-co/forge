/**
 * What an installation is actually granted, asked of GitHub rather than assumed from the manifest.
 *
 * ISS-1153: the manifest is what an App was created asking for, and an installation is what somebody
 * then accepted. The two drift the moment a permission is added to the App — the App holds it, every
 * existing installation does not, and nothing changes until an owner accepts the new grant. Every
 * health signal Forge had answered `ok` throughout, because none of them exercised a permission.
 *
 * Both reads here carry the App's own JWT, so they spend no repository permission and cannot
 * themselves be the thing that is missing.
 */

import { buildAppJwt } from './app-auth.js';
import {
  appPermissionsPageUrl,
  describeShortfall,
  installationShortfall,
  type PermissionShortfall,
} from './app-permissions.js';
import { GITHUB_API_BASE } from './types.js';

const READ_TIMEOUT_MS = 6000;

export type InstallationGrants =
  | {
      read: true;
      /** GitHub's own answer: permission name to level. */
      permissions: Record<string, string>;
      /** The installation's page, where a new grant is accepted. */
      installationUrl: string | null;
    }
  | { read: false; reason: string };

export type AppIdentity =
  | { read: true; slug: string; ownerLogin: string; ownerType: string }
  | { read: false; reason: string };

async function askGitHub(args: {
  appId: string;
  privateKey: string;
  method: 'GET';
  path: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const base = (args.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
  const doFetch = args.fetchImpl ?? fetch;
  const url = `${base}${args.path}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: {
        Authorization: `Bearer ${buildAppJwt(args.appId, args.privateKey, args.nowMs ?? Date.now())}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `GitHub could not be reached at ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.status === 401) {
    return {
      ok: false,
      reason: `GitHub rejected the App JWT at ${args.path} — check the App id and private key`,
    };
  }
  if (!res.ok) return { ok: false, reason: `GitHub answered HTTP ${res.status} at ${args.path}` };
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, reason: `GitHub's answer at ${args.path} was not JSON` };
  }
}

/**
 * The permissions this installation holds right now.
 *
 * An answer with no `permissions` object is a read failure and not an empty grant: reporting it as
 * "this installation holds nothing" would send an operator to re-grant permissions GitHub never
 * said were missing.
 */
export async function readInstallationGrants(args: {
  appId: string;
  privateKey: string;
  installationId: number;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<InstallationGrants> {
  const got = await askGitHub({
    ...args,
    method: 'GET',
    path: `/app/installations/${args.installationId}`,
  });
  if (!got.ok) return { read: false, reason: got.reason };
  const body = got.body as { permissions?: Record<string, string>; html_url?: string };
  if (!body.permissions || typeof body.permissions !== 'object') {
    return {
      read: false,
      reason: `GitHub's answer for installation ${args.installationId} carried no permissions`,
    };
  }
  return { read: true, permissions: body.permissions, installationUrl: body.html_url ?? null };
}

/** Who this App is, so the sentence can name the page a permission is granted on. */
export async function readAppIdentity(args: {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<AppIdentity> {
  const got = await askGitHub({ ...args, method: 'GET', path: '/app' });
  if (!got.ok) return { read: false, reason: got.reason };
  const body = got.body as { slug?: string; owner?: { login?: string; type?: string } };
  if (!body.slug || !body.owner?.login) {
    return { read: false, reason: "GitHub's answer for this App named no slug or owner" };
  }
  return {
    read: true,
    slug: body.slug,
    ownerLogin: body.owner.login,
    ownerType: body.owner.type ?? 'User',
  };
}

/** What the health probe found out about the grant: nothing to say, a sentence, or a read failure. */
export type GrantVerdict =
  | { kind: 'granted' }
  | { kind: 'short'; shortfall: PermissionShortfall[]; message: string }
  | { kind: 'unread'; reason: string };

/**
 * Whether this installation can do what Forge will ask of it.
 *
 * The identity read happens ONLY on the shortfall path. It buys one sentence — the page to grant on
 * — and a health sweep over every binding should not spend a call per tick for a sentence nobody is
 * going to be shown. Where it fails, the shortfall still reports, wording the page in prose.
 */
export async function checkInstallationGrant(args: {
  appId: string;
  privateKey: string;
  installationId: number;
  repository: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<GrantVerdict> {
  const grants = await readInstallationGrants(args);
  if (!grants.read) return { kind: 'unread', reason: grants.reason };

  const shortfall = installationShortfall(grants.permissions);
  if (shortfall.length === 0) return { kind: 'granted' };

  const app = await readAppIdentity(args);
  return {
    kind: 'short',
    shortfall,
    message: describeShortfall({
      repository: args.repository,
      shortfall,
      permissionsUrl: app.read ? appPermissionsPageUrl(app) : null,
      installationUrl: grants.installationUrl,
    }),
  };
}
