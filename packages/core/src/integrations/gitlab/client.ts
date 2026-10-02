/**
 * Calling GitLab's REST v4 API for one binding's project, as the connection's access token.
 *
 * Every request carries the token in `PRIVATE-TOKEN` and nothing else; a failure is raised as
 * `SourceHostCallError` with GitLab's own `message` beside the status, never the request.
 */

import { scrubLogText } from '@forge/observability';
import { SourceHostCallError, SourceHostUnavailable } from '../source-host/errors.js';
import {
  GITLAB_DEFAULT_BASE_URL,
  type GitLabConfig,
  type GitLabSecrets,
  gitlabHostOf,
} from './types.js';

const REQUEST_TIMEOUT_MS = 12_000;

type Method = 'GET' | 'POST' | 'PUT';

export interface GitLabClient {
  bindingId: string;
  /** The instance's web origin, e.g. `https://gitlab.com`. */
  baseUrl: string;
  host: string;
  /** `group/sub/project`, or `project <id>` where the binding names the project by id alone. */
  fullName: string;
  /** The project's web URL, or null where only its id is known. */
  webUrl: string | null;
  /** `/projects/<id or url-encoded path><suffix>`, the path every project call takes. */
  project(suffix: string): string;
  json<T>(method: Method, path: string, body?: unknown): Promise<T>;
  /** Every page of a list endpoint, up to `maxPages`, following GitLab's `x-next-page`. */
  pages<T>(path: string, maxPages: number): Promise<T[]>;
  text(
    path: string,
    maxBytes: number,
    keep?: 'head' | 'tail',
  ): Promise<{ body: string; bytes: number; truncated: boolean }>;
  /** Redact this client's own token, and the generic secret shapes, out of third-party text. */
  scrub(text: string): string;
}

async function gitlabMessage(res: Response): Promise<string | null> {
  try {
    const parsed = (await res.json()) as { message?: unknown; error?: unknown };
    const said = parsed.message ?? parsed.error;
    if (said === undefined) return null;
    return (typeof said === 'string' ? said : JSON.stringify(said)).slice(0, 500);
  } catch {
    return null;
  }
}

/**
 * The client for one binding, or the refusal naming which of its two halves is missing: the
 * project the binding reaches, or the token the connection holds.
 */
export function buildGitLabClient(args: {
  bindingId: string;
  config: GitLabConfig;
  secrets: GitLabSecrets;
}): GitLabClient {
  const { projectPath, projectId } = args.config;
  if (!projectPath && !projectId) {
    throw new SourceHostUnavailable(
      'no_repository',
      'the GitLab binding on this project names no project — set `projectPath` (or `projectId`) on its binding',
      args.bindingId,
    );
  }
  const token = args.secrets.token;
  if (!token) {
    throw new SourceHostUnavailable(
      'no_credential',
      `the connection behind GitLab project ${projectPath ?? projectId} holds no access token`,
      args.bindingId,
    );
  }
  const baseUrl = (args.config.baseUrl ?? GITLAB_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const api = `${baseUrl}/api/v4`;
  const id = projectPath ? encodeURIComponent(projectPath) : String(projectId);
  const fullName = projectPath ?? `project ${projectId}`;

  async function send(method: Method, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        'PRIVATE-TOKEN': token as string,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new SourceHostCallError(
        res.status,
        `${method} ${path} on ${fullName} returned HTTP ${res.status}`,
        await gitlabMessage(res),
      );
    }
    return res;
  }

  const scrub = (text: string) => scrubLogText(text, [token]);

  return {
    bindingId: args.bindingId,
    baseUrl,
    host: gitlabHostOf(args.config),
    fullName,
    webUrl: projectPath ? `${baseUrl}/${projectPath}` : null,
    project: (suffix) => `/projects/${id}${suffix}`,

    async json<T>(method: Method, path: string, body?: unknown): Promise<T> {
      return (await (await send(method, path, body)).json()) as T;
    },

    async pages<T>(path: string, maxPages: number): Promise<T[]> {
      const out: T[] = [];
      const sep = path.includes('?') ? '&' : '?';
      let page: string | null = '1';
      for (let n = 0; page && n < maxPages; n += 1) {
        const res = await send('GET', `${path}${sep}per_page=100&page=${page}`);
        out.push(...((await res.json()) as T[]));
        const next = res.headers.get('x-next-page');
        page = next && next.length > 0 ? next : null;
      }
      return out;
    },

    async text(path, maxBytes, keep = 'head') {
      const redacted = scrub(await (await send('GET', path)).text());
      const buf = Buffer.from(redacted, 'utf8');
      const bytes = buf.byteLength;
      if (bytes <= maxBytes) return { body: redacted, bytes, truncated: false };
      const kept = keep === 'tail' ? buf.subarray(bytes - maxBytes) : buf.subarray(0, maxBytes);
      return { body: kept.toString('utf8'), bytes, truncated: true };
    },

    scrub,
  };
}
