import { type Said, say, sayEn, verbatim } from '@forge/contracts/said';
import type {
  CoolifyApplicationDeploymentsResponse,
  CoolifyApplicationLogsResponse,
  CoolifyApplicationResponse,
  CoolifyCancelResponse,
  CoolifyDeploymentResponse,
  CoolifyDeployResponse,
  CoolifyEnvKey,
  CoolifyResourceResponse,
  CoolifyRollbackImagesResponse,
  CoolifyRollbackResponse,
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
const ROUTE_ABILITIES: { match: RegExp; ability: string }[] = [
  { match: /^POST \/api\/v1\/deploy\b/, ability: 'deploy' },
  { match: /^GET \/api\/v1\/resources\b/, ability: 'read' },
  { match: /^POST \/api\/v1\/deployments\/[^/]+\/cancel\b/, ability: 'deploy' },
  { match: /^GET \/api\/v1\/deployments\//, ability: 'read' },
  { match: /^POST \/api\/v1\/applications\/[^/]+\/rollback\b/, ability: 'deploy' },
  { match: /^GET \/api\/v1\/applications\/[^/]+\/rollback-images\b/, ability: 'read' },
  { match: /^GET \/api\/v1\/applications\/[^/]+\/logs\b/, ability: 'read' },
  { match: /^GET \/api\/v1\/applications\/[^/]+\/envs\b/, ability: 'read' },
  { match: /^(POST|PATCH|DELETE) \/api\/v1\/applications\/[^/]+\/envs\b/, ability: 'write' },
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
export function coolifyForbiddenSaid(err: CoolifyApiError): Said {
  const ability = coolifyAbilityForRoute(err.route);
  return say('integrations.health.coolify.forbidden', {
    route: err.route ? verbatim(err.route) : say('integrations.health.coolify.theRoute'),
    missing: ability
      ? say('integrations.health.coolify.ability', {
          ability: `\`${ability}\``,
          token: `\`api.ability:${ability}\``,
        })
      : say('integrations.health.coolify.theAbility'),
  });
}

/** `coolifyForbiddenSaid` in English, for the plugin and the logs. */
export function describeCoolifyForbidden(err: CoolifyApiError): string {
  return sayEn(coolifyForbiddenSaid(err));
}

interface CoolifyClientOptions {
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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
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

  async listApplicationDeployments(
    applicationUuid: string,
    opts: { skip: number; take: number },
  ): Promise<CoolifyApplicationDeploymentsResponse> {
    const qs = new URLSearchParams({ skip: String(opts.skip), take: String(opts.take) });
    return this.request<CoolifyApplicationDeploymentsResponse>(
      'GET',
      `/api/v1/deployments/applications/${encodeURIComponent(applicationUuid)}?${qs.toString()}`,
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

  /**
   * The application's environment variable NAMES. Coolify answers each with its value; the value
   * is dropped here, at the parse, so it never reaches a caller (ISS-827).
   */
  async listApplicationEnvKeys(resourceUuid: string): Promise<CoolifyEnvKey[]> {
    const list = await withoutBody(this.request<unknown>('GET', envsPath(resourceUuid)));
    return (Array.isArray(list) ? list : []).flatMap((raw) => {
      const e = raw as { uuid?: unknown; key?: unknown; is_preview?: unknown };
      if (typeof e.uuid !== 'string' || typeof e.key !== 'string') return [];
      return [{ uuid: e.uuid, key: e.key, isPreview: e.is_preview === true }];
    });
  }

  /** Create a production (non-preview) variable. Nothing of Coolify's answer is handed on. */
  async createApplicationEnv(resourceUuid: string, env: EnvWrite): Promise<void> {
    await withoutBody(this.request<unknown>('POST', envsPath(resourceUuid), envBody(env)));
  }

  /** Update a production variable, matched by its key. Nothing of Coolify's answer is handed on. */
  async updateApplicationEnv(resourceUuid: string, env: EnvWrite): Promise<void> {
    await withoutBody(this.request<unknown>('PATCH', envsPath(resourceUuid), envBody(env)));
  }

  async deleteApplicationEnv(resourceUuid: string, envUuid: string): Promise<void> {
    await withoutBody(
      this.request<unknown>('DELETE', `${envsPath(resourceUuid)}/${encodeURIComponent(envUuid)}`),
    );
  }

  async listApplications(): Promise<CoolifyApplicationResponse[]> {
    const list = await this.request<CoolifyApplicationResponse[]>('GET', '/api/v1/applications');
    return Array.isArray(list) ? list : [];
  }
}

interface EnvWrite {
  key: string;
  value: string;
}

const envsPath = (resourceUuid: string) =>
  `/api/v1/applications/${encodeURIComponent(resourceUuid)}/envs`;

/**
 * An env call's failure, with Coolify's answer body dropped: a refused write may quote the value it
 * was sent, and the body is what a delivery row or a log line would otherwise carry.
 */
async function withoutBody<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof CoolifyApiError) {
      throw new CoolifyApiError(
        err.status,
        '',
        `Coolify API error: ${err.status}`,
        err.route ?? undefined,
      );
    }
    throw err;
  }
}

const envBody = (env: EnvWrite) => ({ key: env.key, value: env.value, is_preview: false });

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
