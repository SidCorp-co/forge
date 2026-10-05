/**
 * Git over HTTPS, authenticated by a short-lived credential minted per ask (ISS-50 made it any host's).
 *
 * It hands a runner nothing to keep: the runner's git credential helper asks here once per git invocation, and what the device is
 * allowed to reach is decided on every ask from the bindings of the projects it actually runs. Each
 * source host provider says which repository a binding reaches and how its credential is minted
 * (`types.ts:GitCredentialMint`) — a GitHub App installation token, a GitLab access token.
 *
 * Resolution is by host and repository path, not by project: git knows the URL it is fetching and
 * nothing else.
 */

import type { GitRefusalCode } from '@forge/contracts/git';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { integrationBindings, integrationConnections } from '../../db/schema.js';
import { refuser } from '../../lib/refusal.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  forgeReads,
  type GitCredentialMint,
  listIntegrations,
} from '../index.js';

const refuse = refuser<GitRefusalCode>('GIT_REFUSED');

interface GitCredentialGrant {
  username: string;
  password: string;
  expiresAt: string;
  repository: string;
  projectId: string;
}

function mints(): Map<string, GitCredentialMint> {
  return new Map(
    listIntegrations().flatMap((d) =>
      d.gitCredential ? [[d.provider, d.gitCredential] as const] : [],
    ),
  );
}

/** Active bindings of a minting provider on these projects, oldest first, with their connections. */
async function activeHostPairs(byProvider: Map<string, GitCredentialMint>, projectIds: string[]) {
  if (projectIds.length === 0 || byProvider.size === 0) return [];
  return db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationConnections.id, integrationBindings.connectionId),
    )
    .where(
      and(
        inArray(integrationBindings.provider, [...byProvider.keys()]),
        eq(integrationBindings.active, true),
        inArray(integrationBindings.projectId, projectIds),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt));
}

/**
 * Mint a git credential for one device and one repository, or refuse saying which thing is missing:
 * a path git did not send, a binding on no project this device runs, a switched-off connection, or a
 * binding the provider cannot mint for.
 */
export async function mintGitCredentialForDevice(args: {
  deviceId: string;
  host: string;
  path: string;
}): Promise<GitCredentialGrant> {
  const path = args.path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path.includes('/')) {
    throw new HTTPException(400, {
      message: `"${args.path}" is not a repository path — git must be configured with credential.useHttpPath=true for this helper to resolve a repository`,
      cause: { code: 'BAD_REQUEST' },
    });
  }
  const byProvider = mints();
  const rows = await activeHostPairs(byProvider, await forgeReads().deviceProjects(args.deviceId));
  const pair = rows.find((r) =>
    byProvider.get(r.binding.provider)?.reaches(effectiveConfig(r), args.host, path),
  );
  const asked = `${args.host}/${path.replace(/\.git$/i, '')}`;
  if (!pair) {
    throw new HTTPException(404, {
      message: `no active source host binding reaching ${asked} on any project this device runs — bind the repository on the project's Integrations page, and assign this device a runner there`,
      cause: { code: 'NOT_FOUND' },
    });
  }
  const mint = byProvider.get(pair.binding.provider) as GitCredentialMint;
  const config = effectiveConfig(pair);
  const repository = mint.repositoryOf(config);
  if (!pair.connection.active) {
    throw refuse(
      'GIT_CONNECTION_INACTIVE',
      `the ${pair.binding.provider} connection behind ${repository} is gone or deactivated; reconnect it on the project's Integrations page.`,
    );
  }
  let minted: { username: string; password: string; expiresAt: string };
  try {
    minted = await mint.mint({ config, secrets: decryptConnectionSecrets(pair.connection) });
  } catch (err) {
    throw new HTTPException(502, {
      message: `${pair.binding.provider} did not mint a credential for ${repository}: ${err instanceof Error ? err.message : String(err)}`,
      cause: { code: 'GIT_CREDENTIAL_MINT_FAILED' },
    });
  }
  return { ...minted, repository, projectId: pair.binding.projectId };
}

/**
 * Which of these projects can authenticate git through a minted credential, so the provision payload
 * can say so instead of the runner guessing from a URL.
 */
export async function projectsWithHostCredential(projectIds: string[]): Promise<Set<string>> {
  const byProvider = mints();
  const rows = await activeHostPairs(byProvider, projectIds);
  return new Set(
    rows
      .filter((r) => byProvider.get(r.binding.provider)?.serves(effectiveConfig(r)))
      .map((r) => r.binding.projectId),
  );
}

/** Whether a repo URL is one this credential path can authenticate at all. */
export function isHttpsGitUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https:\/\//i.test(url.trim());
}
