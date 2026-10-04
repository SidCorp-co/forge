import { SourceHostCallError, SourceHostUnavailable } from '../source-host/index.js';
import {
  GitHubAuthError,
  installationOctokit,
  isTimeout,
  mintInstallationToken,
  responseOf,
} from './octokit.js';
import type { GitHubConfig, GitHubSecrets, HeadersLike } from './types.js';

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
export type GitHubPublishOp = 'mint' | 'lookup' | 'create' | 'update' | 'merge';

/**
 * Why this project cannot be read as the App. The `reason` is what a caller
 * branches on; the message is what an operator is shown.
 */
type GitHubClientRefusal =
  | 'no_binding'
  | 'no_repository'
  | 'no_installation'
  | 'no_connection'
  | 'no_credential';

export class GitHubClientError extends SourceHostUnavailable {
  declare readonly reason: GitHubClientRefusal;
  constructor(reason: GitHubClientRefusal, message: string) {
    super(reason, message);
    this.name = 'GitHubClientError';
  }
}

/**
 * A failed GitHub read, carrying the status so a caller can tell 404 from 403, and the phase so a
 * 404 minting the installation token is not read as a 404 on the path asked for.
 */
export class GitHubReadError extends SourceHostCallError {
  constructor(status: number, message: string, phase: 'mint' | 'request' = 'request') {
    super(status, message, null, phase);
    this.name = 'GitHubReadError';
  }
}

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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT';
    path: string;
    body?: unknown;
  }): Promise<T>;
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

  const cred = {
    appId,
    privateKey,
    installationId,
    ...(args.config.apiBaseUrl ? { apiBaseUrl: args.config.apiBaseUrl } : {}),
  };
  const octokit = installationOctokit(cred);
  const mint = () => mintInstallationToken(cred);

  return {
    bindingId: args.bindingId,
    appId,
    owner,
    repo,
    fullName,
    async get<T>(path: string): Promise<T> {
      try {
        await mint();
      } catch (err) {
        if (err instanceof GitHubAuthError)
          throw new GitHubReadError(err.status, err.message, 'mint');
        throw err;
      }
      try {
        const res = await octokit.request({
          method: 'GET',
          url: path,
          request: { signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
        });
        return res.data as T;
      } catch (err) {
        const answered = responseOf(err);
        if (!answered) throw err;
        throw new GitHubReadError(
          answered.status,
          `GET ${path} on ${fullName} returned HTTP ${answered.status}`,
        );
      }
    },

    async publish<T>(args: {
      op: GitHubPublishOp;
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      path: string;
      body?: unknown;
    }): Promise<T> {
      try {
        await mint();
      } catch (err) {
        if (err instanceof GitHubAuthError) {
          throw new GitHubPublishError({
            op: 'mint',
            status: err.status,
            headers: err.headers,
            message: err.message,
          });
        }
        throw new GitHubPublishError({
          op: 'mint',
          timedOut: isTimeout(err),
          message: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const res = await octokit.request({
          method: args.method,
          url: args.path,
          ...(args.body === undefined ? {} : { data: args.body }),
          request: {
            signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
            ...(args.method === 'GET' ? {} : { retries: 0 }),
          },
        });
        return res.data as T;
      } catch (err) {
        const answered = responseOf(err);
        if (!answered) {
          throw new GitHubPublishError({
            op: args.op,
            timedOut: isTimeout(err),
            message: err instanceof Error ? err.message : String(err),
          });
        }
        throw new GitHubPublishError({
          op: args.op,
          status: answered.status,
          headers: answered.headers,
          detail: bodyText(answered.data),
          message: `${args.method} ${args.path} on ${fullName} returned HTTP ${answered.status}`,
        });
      }
    },
  };
}

/** GitHub's own words for a refusal, where it sent any. */
function bodyText(data: unknown): string | null {
  if (data === undefined || data === null || data === '') return null;
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return text.length > 0 ? text.slice(0, 2000) : null;
}
