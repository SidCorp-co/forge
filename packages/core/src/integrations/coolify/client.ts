import type { CoolifyDeployResponse, CoolifyResourceResponse } from './types.js';

export class CoolifyApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Coolify API error: ${status}`);
    this.status = status;
    this.body = body;
  }
}

export interface CoolifyClientOptions {
  baseUrl: string;
  apiToken: string;
  /** Optional secondary token tried when the primary fails with 401 (rotation window). */
  previousApiToken?: string;
  timeoutMs?: number;
  /** Override for tests — must implement the global `fetch` contract. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT = 30_000;

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

export class CoolifyClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly previousApiToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CoolifyClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.apiToken = opts.apiToken;
    this.previousApiToken = opts.previousApiToken;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = joinUrl(this.baseUrl, path);
    const tokens = [this.apiToken];
    if (this.previousApiToken) tokens.push(this.previousApiToken);

    let lastErr: Error | null = null;
    for (const token of tokens) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const init: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          signal: controller.signal,
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await this.fetchImpl(url, init);
        clearTimeout(timer);
        if (res.status === 401 && this.previousApiToken && token === this.apiToken) {
          // Try the rotation-window fallback before giving up.
          lastErr = new CoolifyApiError(401, await safeText(res), 'unauthorized (will retry with previous token)');
          continue;
        }
        if (!res.ok) {
          throw new CoolifyApiError(res.status, await safeText(res));
        }
        // Some Coolify endpoints answer success with an empty 204 body.
        if (res.status === 204) return undefined as unknown as T;
        return (await res.json()) as T;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof CoolifyApiError && err.status !== 401) throw err;
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error('Coolify request failed');
  }

  /**
   * Trigger a deploy. Coolify v4 deploy is `GET /api/v1/deploy?uuid=&force=`
   * (query params, GET — NOT a POST with a JSON body).
   * Docs: https://coolify.io/docs/api-reference/api/operations/deploy-by-tag-or-uuid
   * Response is a `deployments[]` array; some versions also surface a
   * top-level `deployment_uuid`, so callers parse defensively.
   */
  async deploy(input: { resourceUuid: string; force?: boolean }): Promise<CoolifyDeployResponse> {
    const qs = new URLSearchParams({
      uuid: input.resourceUuid,
      force: String(input.force ?? false),
    });
    return this.request<CoolifyDeployResponse>('GET', `/api/v1/deploy?${qs.toString()}`);
  }

  /**
   * Healthcheck. Coolify v4 `/api/v1/resources` is LIST-ONLY — there is no
   * get-one-by-uuid under it (that path 404s for any uuid + any token).
   * Docs: https://coolify.io/docs/api-reference/api/operations/list-resources
   * A 2xx on the list proves the API is reachable + the token is valid; we
   * then resolve the uuid client-side and surface a clear not-found instead of
   * a bare 404.
   */
  async getResource(resourceUuid: string): Promise<CoolifyResourceResponse> {
    const list = await this.request<CoolifyResourceResponse[]>('GET', '/api/v1/resources');
    const match = Array.isArray(list) ? list.find((r) => r.uuid === resourceUuid) : undefined;
    if (!match) {
      throw new CoolifyApiError(404, '', `resource ${resourceUuid} not found in Coolify resource list`);
    }
    return match;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
