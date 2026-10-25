/**
 * Git over HTTPS, authenticated by a short-lived credential handed out per ask (ISS-50 made it any host's).
 *
 * It hands a runner nothing to keep: the runner's git credential helper asks here once per git invocation, and what the device is
 * allowed to reach is decided on every ask from the bindings of the projects it actually runs. Each
 * source host provider says which repository a binding reaches and how git is let in
 * (`types.ts:GitCredentialMint`): a GitHub App mints an hour-long installation token for its one
 * repository; a GitLab connection mints nothing a box may hold, so its git goes through Forge's
 * relay (`git-relay.ts`) and the box is handed an hour-long relay ticket instead. The connection's
 * own token is never handed to a runner at or past the relay, whatever it asks (REQ-73 BC-5); an
 * older one keeps it until it updates (`PRE_RELAY_RUNNER_AMNESTY`).
 *
 * Resolution is by host and repository path, not by project: git knows the URL it is fetching and
 * nothing else.
 */

import type { GitRefusalCode } from '@forge/contracts/git';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { integrationBindings, integrationConnections } from '../../db/schema.js';
import { providerRefused } from '../../lib/provider-refusal.js';
import { refuser } from '../../lib/refusal.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  forgeReads,
  type GitCredentialMint,
  listIntegrations,
  type RelayedGitCredential,
} from '../index.js';
import { SourceHostCallError } from './errors.js';
import {
  GIT_RELAY_TICKET_SECONDS,
  type GitRelayGrant,
  gitRelayUrlFor,
  relayedAskOf,
  signGitRelayTicket,
} from './git-relay.js';

const refuse = refuser<GitRefusalCode>('GIT_REFUSED');

/**
 * AMNESTY — cm:hack ISS-685 until:every online device reports forge-runner 0.18.0 or later — then
 * delete this constant, `preRelayCredential` and the branch reading it, so every direct ask for a
 * relayed host is refused GIT_THROUGH_FORGE.
 *
 * The first runner release that moves a checkout's origin to the relay: 0.18 is the runner line this
 * change ships on (`packages/runner/Cargo.toml`), and every runner live today is 0.17.x. A device
 * reporting an older version, or none, still asks GitLab directly and picks a release up only at its
 * update check, so refusing it would cut its masters off fetch and push for hours.
 *   Traded: such a runner is still served the connection's long-lived token on a direct ask, logged.
 *   Costs: that token sits on every box that has not updated.
 */
export const PRE_RELAY_RUNNER_AMNESTY = '0.18.0';

/** Whether a device's reported runner version (`a.b.c`) is at or past the relay; none is not. */
export function relayCapableRunner(version: string | null | undefined): boolean {
  const got = /^(\d+)\.(\d+)\.(\d+)$/.exec(version?.trim() ?? '');
  if (!got) return false;
  const floor = PRE_RELAY_RUNNER_AMNESTY.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = Number(got[i + 1]) - (floor[i] as number);
    if (d !== 0) return d > 0;
  }
  return true;
}

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

type HostPair = Awaited<ReturnType<typeof activeHostPairs>>[number];

/** The active binding of a project this device runs that reaches `host`/`path`, or a refusal naming what is missing. */
async function pairReaching(
  byProvider: Map<string, GitCredentialMint>,
  deviceId: string,
  host: string,
  path: string,
): Promise<{ pair: HostPair; cred: GitCredentialMint; config: Record<string, unknown> }> {
  const rows = await activeHostPairs(byProvider, await forgeReads().deviceProjects(deviceId));
  const pair = rows.find((r) =>
    byProvider.get(r.binding.provider)?.reaches(effectiveConfig(r), host, path),
  );
  if (!pair) {
    throw new HTTPException(404, {
      message: `no active source host binding reaching ${host}/${path.replace(/\.git$/i, '')} on any project this device runs — bind the repository on the project's Integrations page, and assign this device a runner there`,
      cause: { code: 'NOT_FOUND' },
    });
  }
  const cred = byProvider.get(pair.binding.provider) as GitCredentialMint;
  const config = effectiveConfig(pair);
  if (!pair.connection.active) {
    throw refuse(
      'GIT_CONNECTION_INACTIVE',
      `the ${pair.binding.provider} connection behind ${cred.repositoryOf(config)} is gone or deactivated; reconnect it on the project's Integrations page.`,
    );
  }
  return { pair, cred, config };
}

const repoPathOf = (raw: string): string => raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * Hand out a git credential for one device and one repository, or refuse saying which thing is
 * missing: a path git did not send, a binding on no project this device runs, a switched-off
 * connection, a binding the provider cannot mint for, or a relayed host asked for directly.
 */
export async function mintGitCredentialForDevice(args: {
  deviceId: string;
  /** The runner version the device last reported (`devices.agent_version`), or null. */
  agentVersion: string | null;
  host: string;
  path: string;
}): Promise<GitCredentialGrant & { preRelay?: true }> {
  const path = repoPathOf(args.path);
  if (!path.includes('/')) {
    throw new HTTPException(400, {
      message: `"${args.path}" is not a repository path — git must be configured with credential.useHttpPath=true for this helper to resolve a repository`,
      cause: { code: 'BAD_REQUEST' },
    });
  }
  const byProvider = mints();
  const relayed = relayedAskOf(args.host, path);
  if (relayed) return relayTicketFor(byProvider, args.deviceId, relayed);

  const { pair, cred, config } = await pairReaching(byProvider, args.deviceId, args.host, path);
  const repository = cred.repositoryOf(config);
  if (cred.kind === 'relayed') {
    if (!relayCapableRunner(args.agentVersion)) {
      const served = cred.preRelayCredential({
        config,
        secrets: decryptConnectionSecrets(pair.connection),
      });
      return { ...served, repository, projectId: pair.binding.projectId, preRelay: true };
    }
    const through = gitRelayUrlFor(args.host, path);
    if (!through) throw relayUnavailable(repository);
    throw refuse(
      'GIT_THROUGH_FORGE',
      `${repository} is reached through Forge, and its connection's token is never handed out: this checkout's origin still names ${args.host} directly. Point it at ${through} (git remote set-url origin ${through}), or let the runner re-provision the checkout, which does it.`,
    );
  }
  let minted: { username: string; password: string; expiresAt: string };
  try {
    minted = await cred.mint({ config, secrets: decryptConnectionSecrets(pair.connection) });
  } catch (err) {
    throw providerRefused(
      `${pair.binding.provider} did not mint a credential for ${repository}: ${err instanceof Error ? err.message : String(err)}`,
      'GIT_CREDENTIAL_MINT_FAILED',
      { retryAt: err instanceof SourceHostCallError ? err.retryAt : null },
    );
  }
  return { ...minted, repository, projectId: pair.binding.projectId };
}

const relayUnavailable = (repository: string) =>
  refuse(
    'GIT_RELAY_UNAVAILABLE',
    `${repository} is reached only through Forge's git relay, and this server knows no public API origin to relay through; an operator sets PUBLIC_API_BASE_URL. No credential is handed out meanwhile.`,
  );

/** A relay ticket for a relayed repository this device may reach: what git holds instead of the token. */
async function relayTicketFor(
  byProvider: Map<string, GitCredentialMint>,
  deviceId: string,
  asked: { host: string; path: string },
): Promise<GitCredentialGrant> {
  const { pair, cred, config } = await pairReaching(byProvider, deviceId, asked.host, asked.path);
  const repository = cred.repositoryOf(config);
  if (cred.kind !== 'relayed') {
    throw new HTTPException(404, {
      message: `${repository} is not relayed through Forge: its ${pair.binding.provider} binding hands git its own short-lived credential, so clone it from ${asked.host} directly`,
      cause: { code: 'NOT_FOUND' },
    });
  }
  const now = Date.now();
  return {
    username: 'forge-relay',
    password: await signGitRelayTicket({ deviceId, bindingId: pair.binding.id }, now),
    expiresAt: new Date(now + GIT_RELAY_TICKET_SECONDS * 1000).toISOString(),
    repository,
    projectId: pair.binding.projectId,
  };
}

/** What a relayed request goes out to: the repository's smart-HTTP base and the headers that open it. */
export interface RelayedGitUpstream {
  url: string;
  headers: Record<string, string>;
  repository: string;
  projectId: string;
}

/**
 * The upstream a live relay ticket opens for `host`/`repository`, decided again now: the ticket's
 * binding must still be active, on a project its device runs, and reach that repository. Null where
 * any of that no longer holds, which the door refuses by name.
 */
export async function relayedGitUpstream(
  grant: GitRelayGrant,
  host: string,
  repository: string,
): Promise<RelayedGitUpstream | null> {
  const byProvider = mints();
  const rows = await activeHostPairs(byProvider, await forgeReads().deviceProjects(grant.deviceId));
  const pair = rows.find((r) => r.binding.id === grant.bindingId);
  const cred = pair ? byProvider.get(pair.binding.provider) : undefined;
  if (!pair || cred?.kind !== 'relayed' || !pair.connection.active) return null;
  const config = effectiveConfig(pair);
  if (!cred.reaches(config, host, repository)) return null;
  const named = cred.repositoryOf(config);
  let upstream: { url: string; headers: Record<string, string> };
  try {
    upstream = (cred as RelayedGitCredential).upstream({
      config,
      secrets: decryptConnectionSecrets(pair.connection),
    });
  } catch (err) {
    throw refuse(
      'GIT_RELAY_UPSTREAM_REFUSED',
      `${named} cannot be relayed: ${err instanceof Error ? err.message : String(err)}; a project admin reconnects it on the project's Integrations page`,
    );
  }
  return { ...upstream, repository: named, projectId: pair.binding.projectId };
}

/**
 * The remote a project's checkout clones from when its repository is relayed through Forge, or null
 * where it is not (or core knows no public origin), so the caller keeps the host's own URL.
 */
export async function gitRemoteThroughForge(
  projectId: string,
  repository: { host: string; path: string },
): Promise<string | null> {
  const byProvider = mints();
  const rows = await activeHostPairs(byProvider, [projectId]);
  const relayed = rows.some((r) => {
    const cred = byProvider.get(r.binding.provider);
    return (
      cred?.kind === 'relayed' && cred.reaches(effectiveConfig(r), repository.host, repository.path)
    );
  });
  return relayed ? gitRelayUrlFor(repository.host, repository.path) : null;
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
