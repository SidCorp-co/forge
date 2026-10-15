/**
 * The one GitHub App that serves this Forge instance.
 *
 * It is public, so any account can install it, and that is why an installation reaches nobody's
 * projects until it is proven: the App asks for the installer's OAuth authorization on install, and
 * the installation is recorded only when GitHub's answer to that person lists it
 * (`GET /user/installations`). A forged `installation_id` on a genuine return proves nothing,
 * because GitHub answers with the installations the person can reach, not the one the URL names.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  type GithubAccountType,
  INSTANCE_OWNER_ID,
  integrationConnections,
} from '../../db/schema.js';
import { decryptConnectionSecrets, type IntegrationConnectionRow } from '../index.js';
import { appOctokit, responseOf } from './octokit.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';
import { GITHUB_API_BASE } from './types.js';

const GITHUB_WEB = 'https://github.com';
const OAUTH_TIMEOUT_MS = 8000;
const PER_PAGE = 100;
const MAX_INSTALLATION_PAGES = 10;

export { INSTANCE_OWNER_ID };

/** The instance's App, switched on; at most one exists (`integration_connections_one_instance_provider_uq`). */
export async function findInstanceGithubApp(): Promise<IntegrationConnectionRow | null> {
  const [row] = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.provider, 'github'),
        eq(integrationConnections.ownerType, 'instance'),
        eq(integrationConnections.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The live GitHub Apps a person or an org made before the instance had one, oldest first. While one
 * exists and the instance holds none, an operator completes it rather than making a second App.
 */
export async function findAppsAwaitingCompletion(): Promise<IntegrationConnectionRow[]> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(eq(integrationConnections.provider, 'github'), eq(integrationConnections.active, true)),
    )
    .orderBy(integrationConnections.createdAt);
  return rows.filter((row) => {
    if (row.ownerType === 'instance') return false;
    const secrets = decryptConnectionSecrets<GitHubSecrets>(row);
    return Boolean(secrets.appId && secrets.privateKey);
  });
}

/** What the instance App lacks before an installation can be proven, or null when it lacks nothing. */
export function instanceAppGap(connection: IntegrationConnectionRow): string | null {
  const config = (connection.config ?? {}) as GitHubConfig;
  const secrets = decryptConnectionSecrets<GitHubSecrets>(connection);
  const missing = [
    secrets.appId && secrets.privateKey ? null : 'its App id and private key',
    config.appSlug ? null : 'its name on GitHub',
    secrets.clientId ? null : 'its client id',
    secrets.clientSecret ? null : 'its client secret',
  ].filter((m): m is string => m !== null);
  return missing.length === 0 ? null : missing.join(', ');
}

/** Where a person installs the App, carrying the state the return is read by. */
export function installUrl(appSlug: string, state: string): string {
  return `${GITHUB_WEB}/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/** What GitHub says this App is, read with its own JWT: what "complete this App" records. */
export async function readAppIdentity(cred: {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ slug: string; clientId: string; owner: { login: string; isOrg: boolean } }> {
  let body: { slug?: string; client_id?: string; owner?: { login?: string; type?: string } };
  try {
    body = (await appOctokit(cred).request({ method: 'GET', url: '/app' })).data as typeof body;
  } catch (err) {
    const status = responseOf(err)?.status;
    if (status === undefined) throw err;
    throw new Error(
      `GitHub answered HTTP ${status} reading the App with its own key${status === 401 ? ': the App id and private key do not match' : ''}`,
    );
  }
  if (!body.slug || !body.client_id || !body.owner?.login) {
    throw new Error('GitHub read the App without its slug, client id or owner');
  }
  return {
    slug: body.slug,
    clientId: body.client_id,
    owner: { login: body.owner.login, isOrg: body.owner.type === 'Organization' },
  };
}

export type InstallationProof =
  | { ok: true; account: { login: string; type: GithubAccountType } }
  | { ok: false; reason: string };

/**
 * Whether the person GitHub sent back can reach this installation of this App, asked of GitHub with
 * the OAuth code it handed them: the code is exchanged for their token, and their installations of
 * the App are listed. Nothing is kept: the token is spent here and dropped.
 */
export async function proveInstallation(args: {
  code: string;
  installationId: number;
  appId: string;
  clientId: string;
  clientSecret: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<InstallationProof> {
  const doFetch = args.fetchImpl ?? fetch;
  const api = (args.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');

  const exchanged = await doFetch(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
    }),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const grant = (await exchanged.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  if (!exchanged.ok || !grant.access_token) {
    return {
      ok: false,
      reason: `GitHub did not exchange the install's OAuth code (HTTP ${exchanged.status}${grant.error ? `, ${grant.error}` : ''})`,
    };
  }

  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
    const res = await doFetch(`${api}/user/installations?per_page=${PER_PAGE}&page=${page}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${grant.access_token}`,
      },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `GitHub answered HTTP ${res.status} listing the installer's installations`,
      };
    }
    const body = (await res.json()) as {
      installations?: Array<{
        id?: number;
        app_id?: number;
        account?: { login?: string; type?: string };
      }>;
    };
    const batch = body.installations ?? [];
    const hit = batch.find(
      (i) => i.id === args.installationId && String(i.app_id) === String(args.appId),
    );
    if (hit?.account?.login) {
      const type = hit.account.type;
      return {
        ok: true,
        account: {
          login: hit.account.login,
          type: type === 'Organization' || type === 'Enterprise' ? type : 'User',
        },
      };
    }
    if (batch.length < PER_PAGE) break;
  }
  return {
    ok: false,
    reason: `installation ${args.installationId} is not among the installations of this App the installer can reach on GitHub`,
  };
}

/**
 * Whether GitHub takes this client secret for the App's client id. Asked by checking a token that
 * cannot exist: GitHub answers 404 when the pair is the App's own and 401 when it is not, and no
 * token is made or spent either way.
 */
export async function clientSecretHolds(args: {
  clientId: string;
  clientSecret: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ holds: true } | { holds: false; reason: string }> {
  const api = (args.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
  const basic = Buffer.from(`${args.clientId}:${args.clientSecret}`).toString('base64');
  const res = await (args.fetchImpl ?? fetch)(
    `${api}/applications/${encodeURIComponent(args.clientId)}/token`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ access_token: 'forge-checks-the-client-secret' }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    },
  );
  if (res.status === 404 || res.status === 422) return { holds: true };
  if (res.status === 401) {
    return {
      holds: false,
      reason: "GitHub does not take this client secret for the App's client id",
    };
  }
  return { holds: false, reason: `GitHub answered HTTP ${res.status} checking the client secret` };
}

/** One installation of the App as GitHub reads it with the App's own JWT, or null once it is gone. */
export async function readInstallation(cred: {
  appId: string;
  privateKey: string;
  installationId: number;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ login: string; type: GithubAccountType } | null> {
  try {
    const body = (
      await appOctokit(cred).request({
        method: 'GET',
        url: `/app/installations/${cred.installationId}`,
      })
    ).data as { account?: { login?: string; type?: string } };
    const type = body.account?.type;
    return {
      login: body.account?.login ?? '',
      type: type === 'Organization' || type === 'Enterprise' ? type : 'User',
    };
  } catch (err) {
    const status = responseOf(err)?.status;
    if (status === 404) return null;
    if (status === undefined) throw err;
    throw new Error(`GitHub answered HTTP ${status} reading installation ${cred.installationId}`);
  }
}
