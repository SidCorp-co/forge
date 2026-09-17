/**
 * Reading a project's repository as the GitHub App, not as a person.
 *
 * Every write and every read Forge makes to GitHub is the App acting for a
 * named run: attributable, scoped per project, and revocable from one place
 * without touching a box. The alternative is what ISS-1062 measured — every
 * merge on forge-dev made under `junixlabs`, a personal account in a `gh`
 * config file on the runner, invisible to Forge and impossible to audit.
 *
 * Resolution here is by PROJECT, which is what a webhook delivery and a kernel
 * transition both know. `git/github-app-credential.ts` resolves the same App by
 * DEVICE and repository, because a git credential helper is handed a URL and
 * nothing else; the two are different keys onto the same credential and share
 * the token mint rather than either one's lookup.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings } from '../../db/schema.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import { GitHubAuthError, installationToken } from './app-auth.js';
import { GITHUB_API_BASE, type GitHubConfig, type GitHubSecrets } from './types.js';

const READ_TIMEOUT_MS = 6000;

/**
 * Why this project cannot be read as the App. The `reason` is what a caller
 * branches on; the message is what an operator is shown.
 */
export type GitHubClientRefusal =
  | 'no_binding'
  | 'no_repository'
  | 'no_installation'
  | 'no_connection'
  | 'no_credential';

export class GitHubClientError extends Error {
  readonly reason: GitHubClientRefusal;
  constructor(reason: GitHubClientRefusal, message: string) {
    super(message);
    this.name = 'GitHubClientError';
    this.reason = reason;
  }
}

/** A failed GitHub read, carrying the status so a caller can tell 404 from 403. */
export class GitHubReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubReadError';
    this.status = status;
  }
}

export interface GitHubRepoClient {
  bindingId: string;
  owner: string;
  repo: string;
  /** `owner/repo`, as the binding spells it. */
  fullName: string;
  /** GET a repository path, relative to the API base, as the installation. */
  get<T>(path: string): Promise<T>;
}

/** The binding a project's github reads go through, or a named refusal. */
// cm:guard oldest ACTIVE binding wins and the order is not cosmetic: `providerCanDeploy('github')` is false so every github binding is `role: 'service'`, and `integration_bindings_service_uq` allows one per (project, provider, label) — a second label is representable, and an unordered pick would make the projection read a different repository between two deliveries of one event.
async function findGitHubBinding(projectId: string) {
  const [row] = await db
    .select({
      id: integrationBindings.id,
      connectionId: integrationBindings.connectionId,
      config: integrationBindings.config,
    })
    .from(integrationBindings)
    .where(
      and(
        eq(integrationBindings.provider, 'github'),
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.active, true),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The reader for one binding, from the credential a caller already holds.
 *
 * This is the door a webhook delivery takes: the delivery names its own binding
 * and re-resolving by project would pick the oldest active one, which is a
 * different repository the moment a project holds two.
 */
export function buildRepoClient(args: {
  bindingId: string;
  config: GitHubConfig;
  secrets: GitHubSecrets;
}): GitHubRepoClient {
  const { owner, repo, installationId } = args.config;
  if (!owner || !repo) {
    throw new GitHubClientError(
      'no_repository',
      `the GitHub binding on this project names no owner/repo — pick the repository on its Integrations page`,
    );
  }
  const fullName = `${owner}/${repo}`;
  if (!installationId) {
    throw new GitHubClientError(
      'no_installation',
      `${fullName} is bound but the App is not installed for that binding — install it on the account that owns ${owner}; reconnecting will not change this`,
    );
  }
  const { appId, privateKey } = args.secrets;
  if (!appId || !privateKey) {
    throw new GitHubClientError(
      'no_credential',
      `the connection behind ${fullName} holds no GitHub App credential`,
    );
  }

  const base = (args.config.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
  const mint = () =>
    installationToken({
      appId,
      privateKey,
      installationId,
      ...(args.config.apiBaseUrl ? { apiBaseUrl: args.config.apiBaseUrl } : {}),
    });

  return {
    bindingId: args.bindingId,
    owner,
    repo,
    fullName,
    async get<T>(path: string): Promise<T> {
      // cm:guard the token is minted per CALL and never held on the client — `app-auth.ts` caches it until five minutes before it lapses, so this costs nothing per call and a client held across an hour-long job does not go stale in the caller's hand.
      let token: string;
      try {
        token = await mint();
      } catch (err) {
        if (err instanceof GitHubAuthError) throw new GitHubReadError(err.status, err.message);
        throw err;
      }
      const res = await fetch(`${base}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new GitHubReadError(
          res.status,
          `GET ${path} on ${fullName} returned HTTP ${res.status}`,
        );
      }
      return (await res.json()) as T;
    },
  };
}

/**
 * The App-authenticated reader for this project's repository, or a refusal
 * naming which of the five things is missing.
 *
 * Each refusal sends the operator somewhere different, which is the whole
 * reason they are five and not one: a missing installation is an authorization
 * to grant, a missing credential is a connection to re-make, and a missing
 * binding is a repository nobody has chosen yet. Collapsing them tells an
 * operator to reconnect when reconnecting reproduces the state exactly — the
 * mislabel ISS-924 filed against the coolify adapter.
 */
export async function githubRepoClient(projectId: string): Promise<GitHubRepoClient> {
  const binding = await findGitHubBinding(projectId);
  if (!binding) {
    throw new GitHubClientError(
      'no_binding',
      `this project has no active GitHub binding — bind a repository on its Integrations page`,
    );
  }
  const connection = await findConnectionById(binding.connectionId);
  if (!connection?.active) {
    throw new GitHubClientError(
      'no_connection',
      `the GitHub connection behind this project's binding is gone or deactivated`,
    );
  }
  return buildRepoClient({
    bindingId: binding.id,
    config: (binding.config ?? {}) as GitHubConfig,
    secrets: decryptConnectionSecrets<GitHubSecrets>(connection),
  });
}
