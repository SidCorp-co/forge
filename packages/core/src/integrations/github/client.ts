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
import {
  GITHUB_API_BASE,
  type GitHubConfig,
  type GitHubSecrets,
  type HeadersLike,
} from './types.js';

const READ_TIMEOUT_MS = 6000;
const PUBLISH_TIMEOUT_MS = 8000;

/**
 * Which step of a publish a refusal came from. ISS-1072.
 *
 * A publish is four operations that can each fail differently, and the status
 * alone says nothing about which one it was: a 404 while minting means the
 * installation does not exist, and a 404 on `create` means the App no longer
 * reaches the repository. Reporting either as the other invents a history.
 */
export type GitHubPublishOp = 'mint' | 'lookup' | 'create' | 'update';

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

/**
 * A failed step of a publish, carrying everything a sentence about it is built
 * from. ISS-1072.
 *
 * It is a separate class from `GitHubReadError` on purpose, and the reason is
 * the same one that made `client.get` wrong for the publish lookup:
 * `GitHubReadError` carries a status and nothing else, and `get` converts a
 * `GitHubAuthError` into one, so by the time a caller sees it, whether the
 * failure was at the mint or on the repository is gone — and that is the very
 * distinction criterion 24 exists to keep. `timedOut` is here rather than
 * inferred from a message because "the write did not happen" and "the write may
 * have happened and I did not hear" are different things to tell an operator.
 */
export class GitHubPublishError extends Error {
  readonly op: GitHubPublishOp;
  readonly status: number | null;
  readonly headers: HeadersLike | null;
  readonly detail: string | null;
  readonly timedOut: boolean;
  constructor(args: {
    op: GitHubPublishOp;
    status?: number | null;
    headers?: HeadersLike | null;
    detail?: string | null;
    timedOut?: boolean;
    message: string;
  }) {
    super(args.message);
    this.name = 'GitHubPublishError';
    this.op = args.op;
    this.status = args.status ?? null;
    this.headers = args.headers ?? null;
    this.detail = args.detail ?? null;
    this.timedOut = args.timedOut === true;
  }
}

export interface GitHubRepoClient {
  bindingId: string;
  /** The App's own numeric id, so a lookup can filter to runs THIS App published. */
  appId: string;
  owner: string;
  repo: string;
  /** `owner/repo`, as the binding spells it. */
  fullName: string;
  /** GET a repository path, relative to the API base, as the installation. */
  get<T>(path: string): Promise<T>;
  /**
   * One request on the publish path — the lookup and the write alike — raising
   * `GitHubPublishError` with the evidence a refusal is worded from.
   */
  publish<T>(args: {
    op: GitHubPublishOp;
    method: 'GET' | 'POST' | 'PATCH';
    path: string;
    body?: unknown;
  }): Promise<T>;
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
    appId,
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

    // cm:guard the lookup goes through HERE and never through `get` above, though both are a GET. `get` collapses a `GitHubAuthError` into a `GitHubReadError` and keeps only the status, which throws away the two things a publish refusal is built from: whether the failure was at the mint or on the repository, and the rate-limit headers that tell an exhausted quota from an ungranted permission. Routing the lookup through `get` to save nine lines is how criterion 24 stops holding.
    async publish<T>(args: {
      op: GitHubPublishOp;
      method: 'GET' | 'POST' | 'PATCH';
      path: string;
      body?: unknown;
    }): Promise<T> {
      let token: string;
      try {
        token = await mint();
      } catch (err) {
        if (err instanceof GitHubAuthError) {
          // cm:guard the mint keeps `app-auth.ts`'s OWN wording. Its 404 sentence is about an installation that does not exist; rewording it here as a repository the App was removed from is the invented history criterion 24 forbids, and an operator sent to the wrong page by it loses the afternoon.
          throw new GitHubPublishError({
            op: 'mint',
            status: err.status,
            headers: err.headers,
            message: err.message,
          });
        }
        throw new GitHubPublishError({
          op: 'mint',
          timedOut: isAbort(err),
          message: err instanceof Error ? err.message : String(err),
        });
      }

      let res: Response;
      try {
        res = await fetch(`${base}${args.path}`, {
          method: args.method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(args.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
          signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        });
      } catch (err) {
        throw new GitHubPublishError({
          op: args.op,
          timedOut: isAbort(err),
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (!res.ok) {
        throw new GitHubPublishError({
          op: args.op,
          status: res.status,
          headers: res.headers,
          detail: await bodyText(res),
          message: `${args.method} ${args.path} on ${fullName} returned HTTP ${res.status}`,
        });
      }
      return (await res.json()) as T;
    },
  };
}

/** Whether a thrown value is the timeout `AbortSignal.timeout` raises. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** GitHub's own words for a refusal, where it sent any. Never fatal on its own. */
async function bodyText(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.length > 0 ? text.slice(0, 2000) : null;
  } catch {
    return null;
  }
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
