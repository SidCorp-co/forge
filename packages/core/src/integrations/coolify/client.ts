import type {
  CoolifyApplicationLogsResponse,
  CoolifyDeploymentResponse,
  CoolifyDeployResponse,
  CoolifyResourceResponse,
} from './types.js';

export class CoolifyApiError extends Error {
  readonly status: number;
  readonly body: string;
  /** The route that produced this error, e.g. `POST /api/v1/deploy`. */
  readonly route: string | null;
  constructor(status: number, body: string, message?: string, route?: string) {
    super(message ?? `Coolify API error: ${status}`);
    this.status = status;
    this.body = body;
    this.route = route ?? null;
  }
}

/**
 * Coolify v4 ability middleware, per route this client calls. Every v4 API route
 * sits behind one of `api.ability:read | write | deploy | read:sensitive | root`,
 * and a token that lacks the one its route wants answers 403 — not 401.
 */
// cm:edge contract -> packages/core/src/integrations/coolify/adapter.ts — the adapter turns a 403 into the operator-facing `needs_scope` message using this table, so a route added to CoolifyClient without a row here degrades that message to "an ability it does not have" instead of naming one
const ROUTE_ABILITIES: { match: RegExp; ability: string }[] = [
  { match: /^POST \/api\/v1\/deploy\b/, ability: 'deploy' },
  { match: /^GET \/api\/v1\/resources\b/, ability: 'read' },
  { match: /^GET \/api\/v1\/deployments\//, ability: 'read' },
  { match: /^GET \/api\/v1\/applications\/[^/]+\/logs\b/, ability: 'read' },
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
          throw new CoolifyApiError(res.status, await safeText(res), undefined, route);
        }
        // cm:guard a 204 must return before `res.json()` — several Coolify endpoints answer success with an empty body and parsing it throws a SyntaxError that reads like a transport failure
        if (res.status === 204) return undefined as unknown as T;
        return (await res.json()) as T;
      } catch (err) {
        clearTimeout(timer);
        // cm:guard ONLY a 401 falls through to the previous token. A 403 means Coolify recognised this token and refused the route, so a second token minted from the same scope fails identically — the retry would cost a round trip and blur the diagnosis (ISS-924).
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
  // cm:guard POST, never GET — Coolify pointed `GET /api/v1/deploy` at a 405 stub ("This endpoint has changed to a POST request") in v4.2.0 (upstream 0633b543, 2026-07-19), while POST has been accepted since long before it, so POST is the one method that works on every version. The same swap hit `applications/{uuid}/start|restart|stop`, `servers/{uuid}/validate` and `enable`/`disable`: reach for POST on anything that changes state.
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
    const list = await this.request<CoolifyResourceResponse[]>('GET', '/api/v1/resources');
    const match = Array.isArray(list) ? list.find((r) => r.uuid === resourceUuid) : undefined;
    if (!match) {
      throw new CoolifyApiError(
        404,
        '',
        `resource ${resourceUuid} not found in Coolify resource list`,
        'GET /api/v1/resources',
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

  /**
   * Fetch recent RUNTIME container logs for an application (the live container,
   * not the build log — that's `getDeployment`). Coolify v4
   * `GET /api/v1/applications/{uuid}/logs?lines=N` → `{ logs }`. `lines` is
   * clamped 1..1000. CAVEAT: for a docker-compose application this returns only
   * ONE container's logs with no working per-service selector — see
   * {@link CoolifyApplicationLogsResponse}.
   * Docs: https://coolify.io/docs/api-reference/api/operations/get-application-logs-by-uuid
   */
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
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
