import type {
  CoolifyDeployResponse,
  CoolifyResourceResponse,
  CoolifyRollbackResponse,
} from './types.js';

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
        // 204 — Coolify uses this for rollback in some versions.
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

  /** Trigger a deploy. Returns the deployment_uuid Coolify mints for tracking. */
  async deploy(input: { resourceUuid: string; force?: boolean }): Promise<CoolifyDeployResponse> {
    return this.request<CoolifyDeployResponse>('POST', '/api/v1/deploy', {
      uuid: input.resourceUuid,
      force: input.force ?? false,
    });
  }

  /** Healthcheck: GET the resource. 2xx = "API reachable + token valid + resource exists". */
  async getResource(resourceUuid: string): Promise<CoolifyResourceResponse> {
    return this.request<CoolifyResourceResponse>(
      'GET',
      `/api/v1/resources/${encodeURIComponent(resourceUuid)}`,
    );
  }

  /** Roll back the named deployment. */
  async rollback(deploymentUuid: string): Promise<CoolifyRollbackResponse> {
    return this.request<CoolifyRollbackResponse>(
      'POST',
      `/api/v1/deployments/${encodeURIComponent(deploymentUuid)}/rollback`,
    );
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
