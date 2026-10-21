import { STATUS_CODES } from 'node:http';
import type {
  CoolifyApplicationLogsResponse,
  CoolifyApplicationResponse,
  CoolifyCancelResponse,
  CoolifyDeploymentResponse,
  CoolifyDeployResponse,
  CoolifyResourceResponse,
  CoolifyRollbackImagesResponse,
  CoolifyRollbackResponse,
} from './types.js';

export class CoolifyApiError extends Error {
  /** The HTTP status the host sent, a 2xx included where its body was not what Coolify sends. */
  readonly status: number;
  readonly body: string;
  /** The route that produced this error, e.g. `POST /api/v1/deploy`. */
  readonly route: string | null;
  /** Whether what the host answered says the address may not be a Coolify server's. */
  readonly addressSuspect: boolean;
  constructor(
    status: number,
    body: string,
    message?: string,
    route?: string,
    addressSuspect = false,
  ) {
    super(message ?? `The server answered HTTP ${status}${route ? ` to ${route}` : ''}.`);
    this.status = status;
    this.body = body;
    this.route = route ?? null;
    this.addressSuspect = addressSuspect;
  }
}

/** "404 Not Found", or the bare number where the status has no registered name. */
function statusWords(status: number): string {
  const name = STATUS_CODES[status];
  return name ? `${status} ${name}` : `HTTP ${status}`;
}

/** The saved address without its scheme: its host, and the path a request was sent under where it has one. */
function hostOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname.replace(/\/+$/, '')}` || baseUrl;
  } catch {
    return baseUrl;
  }
}

/**
 * Coolify v4 ability middleware, per route this client calls. Every v4 API route
 * sits behind one of `api.ability:read | write | deploy | read:sensitive | root`,
 * and a token that lacks the one its route wants answers 403 — not 401.
 */
const ROUTE_ABILITIES: { match: RegExp; ability: string }[] = [
  { match: /^POST \/api\/v1\/deploy\b/, ability: 'deploy' },
  { match: /^GET \/api\/v1\/resources\b/, ability: 'read' },
  { match: /^POST \/api\/v1\/deployments\/[^/]+\/cancel\b/, ability: 'deploy' },
  { match: /^GET \/api\/v1\/deployments\//, ability: 'read' },
  { match: /^POST \/api\/v1\/applications\/[^/]+\/rollback\b/, ability: 'deploy' },
  { match: /^GET \/api\/v1\/applications\/[^/]+\/rollback-images\b/, ability: 'read' },
  { match: /^GET \/api\/v1\/applications\/[^/]+\/logs\b/, ability: 'read' },
  { match: /^GET \/api\/v1\/applications\b/, ability: 'read' },
];

/** The `api.ability:*` name a route requires, or `null` for a route not in the table. */
export function coolifyAbilityForRoute(route: string | null): string | null {
  if (!route) return null;
  return ROUTE_ABILITIES.find((r) => r.match.test(route))?.ability ?? null;
}

/**
 * The operator sentence for a 403. Coolify KNOWS this token and refuses this
 * route, so the fix is to widen the token's abilities — never to mint a new one,
 * which reproduces the state exactly (ISS-924).
 */
export function describeCoolifyForbidden(err: CoolifyApiError): string {
  const route = err.route ?? 'the requested route';
  const ability = coolifyAbilityForRoute(err.route);
  const missing = ability
    ? `the \`${ability}\` ability (\`api.ability:${ability}\`)`
    : 'the ability that route requires';
  return `Coolify recognised the API token but refused ${route} (HTTP 403): the token is missing ${missing}. Widen this token's abilities in Coolify (Keys & Tokens → edit the token) — the credential itself is valid, so replacing it will not change this.`;
}

/** Every refusal reading a Coolify answer words it here, so none says "Coolify answered" (ISS-1421 r17). */
export function describeCoolifyAnswer(err: CoolifyApiError): string {
  if (err.status === 403) return describeCoolifyForbidden(err);
  const said = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
  return err.addressSuspect ? `${said} Check the address saved on this connection.` : said;
}

/** A 404 here does not say whether the route or the application is missing, so the refusal says that and quotes the body. */
export function describeCoolifyRollbackImagesRefusal(err: CoolifyApiError): string {
  if (err.status !== 404) return describeCoolifyAnswer(err);
  const body = err.body.replace(/\s+/g, ' ').trim().slice(0, 200);
  const said = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
  return `${said} Forge has no rollback image list to read and no tag to roll back to. A 404 here reads the same whether the server lacks the route or does not know the application (the targets read says whether it lists it), so check the address saved on this connection first.${body ? ` The body it sent: ${body}` : ''}`;
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

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return (await this.send<T>(method, path, body)).data;
  }

  /** What the host answered, said of the host: whether it is Coolify is what the answer is about. */
  private answered(status: number, route: string): string {
    const said = `The server at ${hostOf(this.baseUrl)} answered ${statusWords(status)} to ${route}`;
    return status === 404 ? `${said}, so it may not be Coolify.` : `${said}.`;
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const url = joinUrl(this.baseUrl, path);
    const route = `${method} ${path.split('?')[0]}`;
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
          lastErr = new CoolifyApiError(
            401,
            await safeText(res),
            'unauthorized (will retry with previous token)',
            route,
          );
          continue;
        }
        if (!res.ok) {
          throw new CoolifyApiError(
            res.status,
            await safeText(res),
            this.answered(res.status, route),
            route,
            res.status !== 401 && res.status !== 403 && res.status < 500,
          );
        }
        if (res.status === 204) return { status: res.status, data: undefined as unknown as T };
        return { status: res.status, data: (await res.json()) as T };
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof CoolifyApiError && err.status !== 401) throw err;
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error('Coolify request failed');
  }

  /**
   * Trigger a deploy. `uuid` and `force` go in the QUERY STRING, not a JSON
   * body — `DeployController::deploy` reads them off the query either way.
   * Response is a `deployments[]` array; some versions also surface a
   * top-level `deployment_uuid`, so callers parse defensively.
   */
  async deploy(input: { resourceUuid: string; force?: boolean }): Promise<CoolifyDeployResponse> {
    const qs = new URLSearchParams({
      uuid: input.resourceUuid,
      force: String(input.force ?? false),
    });
    return this.request<CoolifyDeployResponse>('POST', `/api/v1/deploy?${qs.toString()}`);
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
    const route = 'GET /api/v1/resources';
    // The status carried is the one the host sent: a 200 whose body is no list says the address
    // may not be Coolify's, and a list without the uuid says the binding names the wrong resource.
    const { status, data } = await this.send<unknown>('GET', '/api/v1/resources');
    if (!Array.isArray(data)) {
      throw new CoolifyApiError(
        status,
        '',
        `The server at ${hostOf(this.baseUrl)} answered ${route} with something other than a list of resources, so it may not be Coolify.`,
        route,
        true,
      );
    }
    const match = (data as CoolifyResourceResponse[]).find((r) => r.uuid === resourceUuid);
    if (!match) {
      throw new CoolifyApiError(
        status,
        '',
        `Coolify lists no resource ${resourceUuid}. Check the resource this binding names.`,
        route,
      );
    }
    return match;
  }

  /**
   * Fetch a single deployment (status + build/deploy log). Unlike
   * `/api/v1/resources` (list-only), `deployments/{uuid}` is a get-one
   * endpoint, so a direct path is correct. A non-2xx surfaces as
   * `CoolifyApiError`; the response shape varies across Coolify versions, so
   * callers parse `logs`/`status` defensively (see `CoolifyDeploymentResponse`).
   * Docs: https://coolify.io/docs/api-reference/api/operations/get-deployment-by-uuid
   */
  async getDeployment(deploymentUuid: string): Promise<CoolifyDeploymentResponse> {
    return this.request<CoolifyDeploymentResponse>(
      'GET',
      `/api/v1/deployments/${encodeURIComponent(deploymentUuid)}`,
    );
  }

  async getApplicationLogs(
    resourceUuid: string,
    opts?: { lines?: number },
  ): Promise<CoolifyApplicationLogsResponse> {
    const lines = Math.min(Math.max(1, Math.floor(opts?.lines ?? 100)), 1000);
    const qs = new URLSearchParams({ lines: String(lines) });
    return this.request<CoolifyApplicationLogsResponse>(
      'GET',
      `/api/v1/applications/${encodeURIComponent(resourceUuid)}/logs?${qs.toString()}`,
    );
  }

  async cancelDeployment(deploymentUuid: string): Promise<CoolifyCancelResponse> {
    return this.request<CoolifyCancelResponse>(
      'POST',
      `/api/v1/deployments/${encodeURIComponent(deploymentUuid)}/cancel`,
    );
  }

  async listRollbackImages(resourceUuid: string): Promise<CoolifyRollbackImagesResponse> {
    return this.request<CoolifyRollbackImagesResponse>(
      'GET',
      `/api/v1/applications/${encodeURIComponent(resourceUuid)}/rollback-images`,
    );
  }

  async rollbackApplication(input: {
    resourceUuid: string;
    commit: string;
  }): Promise<CoolifyRollbackResponse> {
    return this.request<CoolifyRollbackResponse>(
      'POST',
      `/api/v1/applications/${encodeURIComponent(input.resourceUuid)}/rollback`,
      { commit: input.commit },
    );
  }

  async listApplications(): Promise<CoolifyApplicationResponse[]> {
    const list = await this.request<CoolifyApplicationResponse[]>('GET', '/api/v1/applications');
    return Array.isArray(list) ? list : [];
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
