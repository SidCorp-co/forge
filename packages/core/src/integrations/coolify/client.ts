import { STATUS_CODES } from 'node:http';
import { CHECK_ADDRESS } from '../unreached.js';
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
    super(message ?? `The server answered HTTP ${status}${whenAsked(route ?? null)}.`);
    this.status = status;
    this.body = body;
    this.route = route ?? null;
    this.addressSuspect = addressSuspect;
  }
}

/** One route this client sends, and what it asks the server for, in a person's words. */
const ROUTE_WORDS: { match: RegExp; words: (m: RegExpExecArray) => string }[] = [
  { match: /^POST \/api\/v1\/deploy$/, words: () => 'a deploy' },
  { match: /^GET \/api\/v1\/resources$/, words: () => 'its list of resources' },
  { match: /^GET \/api\/v1\/applications$/, words: () => 'its list of applications' },
  {
    match: /^GET \/api\/v1\/applications\/([^/]+)\/rollback-images$/,
    words: (m) => `the rollback images of application ${decodeURIComponent(m[1] ?? '')}`,
  },
  {
    match: /^GET \/api\/v1\/applications\/([^/]+)\/logs$/,
    words: (m) => `the logs of application ${decodeURIComponent(m[1] ?? '')}`,
  },
  {
    match: /^POST \/api\/v1\/applications\/([^/]+)\/rollback$/,
    words: (m) => `a rollback of application ${decodeURIComponent(m[1] ?? '')}`,
  },
  {
    match: /^POST \/api\/v1\/deployments\/([^/]+)\/cancel$/,
    words: (m) => `a cancel of deployment ${decodeURIComponent(m[1] ?? '')}`,
  },
  {
    match: /^GET \/api\/v1\/deployments\/([^/]+)$/,
    words: (m) => `deployment ${decodeURIComponent(m[1] ?? '')}`,
  },
];

/**
 * What a request asked the server for, said to a person: "its list of applications", never the HTTP
 * route, which stays on the error's `route` for logs and the ability table (ISS-1421 r28, judge-114).
 */
function askedFor(route: string | null): string | null {
  for (const { match, words } of ROUTE_WORDS) {
    const m = route === null ? null : match.exec(route);
    if (m) return words(m);
  }
  return null;
}

/** " when asked for its list of applications", or nothing for a request this client has no words for. */
function whenAsked(route: string | null): string {
  const asked = askedFor(route);
  return asked ? ` when asked for ${asked}` : '';
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
  const asked = askedFor(err.route);
  const request = asked ? `the request for ${asked}` : 'the request';
  const ability = coolifyAbilityForRoute(err.route);
  const missing = ability
    ? `the \`${ability}\` ability (\`api.ability:${ability}\`)`
    : 'the ability that request requires';
  const said = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
  return `${said} If this is Coolify, it knows the API token but refused ${request}: the token is missing ${missing}. Widen this token's abilities in Coolify (Keys & Tokens → edit the token); the credential itself is valid, so replacing it will not change this.`;
}

/**
 * The sentence for a 401, said of the server at the saved address: a server that is not Coolify
 * refuses a token too, so neither reading is put as fact (ISS-1421 r18).
 */
export function describeCoolifyUnauthorized(err: CoolifyApiError): string {
  const said = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
  return `${said} If this is Coolify, it refused the stored API token, so save a new token from Keys & Tokens in Coolify. ${CHECK_ADDRESS.ifNot}`;
}

/** Every refusal reading a Coolify answer words it here, so none says "Coolify answered" (ISS-1421 r17). */
export function describeCoolifyAnswer(err: CoolifyApiError): string {
  if (err.status === 401) return describeCoolifyUnauthorized(err);
  if (err.status === 403) return describeCoolifyForbidden(err);
  const said = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
  return err.addressSuspect ? `${said} ${CHECK_ADDRESS.alone}` : said;
}

/** A 404 here does not say whether the route or the application is missing, so the refusal says that and quotes the body. */
export function describeCoolifyRollbackImagesRefusal(err: CoolifyApiError): string {
  if (err.status !== 404) return describeCoolifyAnswer(err);
  const body = err.body.replace(/\s+/g, ' ').trim();
  const said = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
  const sent = /^<(?:!doctype|html|\?xml|head|body)\b/i.test(body)
    ? ' It sent a web page, not an answer from an API.'
    : body
      ? ` The body it sent: ${body.slice(0, 200)}`
      : '';
  return `${said} Forge has no rollback image list to read and no tag to roll back to. A 404 here reads the same whether the server lacks the route or does not know the application (the targets read says whether it lists it), ${CHECK_ADDRESS.first}${sent}`;
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

/** Coolify's rollback answer: `images` a list of objects where sent, else `current` alone. */
function isRollbackImageList(data: unknown): data is CoolifyRollbackImagesResponse {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  const { images } = data as { images?: unknown };
  if (images === undefined) return 'current' in data;
  return Array.isArray(images) && images.every((i) => i !== null && typeof i === 'object');
}

export class CoolifyClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly previousApiToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private answeredOnPrevious = false;

  constructor(opts: CoolifyClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.apiToken = opts.apiToken;
    this.previousApiToken = opts.previousApiToken;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get address(): string {
    return hostOf(this.baseUrl);
  }

  get usedPreviousToken(): boolean {
    return this.answeredOnPrevious;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return (await this.send<T>(method, path, body)).data;
  }

  /** What the host answered, said of the host: whether it is Coolify is what the answer is about. */
  private answered(status: number, route: string): string {
    const said = `The server at ${hostOf(this.baseUrl)} answered ${statusWords(status)}${whenAsked(route)}`;
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
          lastErr = new CoolifyApiError(401, await safeText(res), this.answered(401, route), route);
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
        const data = res.status === 204 ? undefined : await res.json();
        if (token !== this.apiToken) this.answeredOnPrevious = true;
        return { status: res.status, data: data as T };
      } catch (err) {
        clearTimeout(timer);
        throw token === this.apiToken ? err : (lastErr ?? err);
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
    if (!Array.isArray(data)) throw this.notCoolify(status, route, 'a list of resources');
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
    const path = `/api/v1/applications/${encodeURIComponent(resourceUuid)}/rollback-images`;
    const { status, data } = await this.send<unknown>('GET', path);
    if (!isRollbackImageList(data))
      throw this.notCoolify(status, `GET ${path}`, 'a rollback image list');
    return data;
  }

  /** A 2xx whose body is not the shape Coolify sends: the address may not be Coolify's. */
  private notCoolify(status: number, route: string, what: string): CoolifyApiError {
    return new CoolifyApiError(
      status,
      '',
      `The server at ${hostOf(this.baseUrl)} was asked for ${askedFor(route) ?? what} and answered with something other than ${what}, so it may not be Coolify.`,
      route,
      true,
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
    const route = 'GET /api/v1/applications';
    const { status, data } = await this.send<unknown>('GET', '/api/v1/applications');
    if (!Array.isArray(data)) throw this.notCoolify(status, route, 'a list of applications');
    return data as CoolifyApplicationResponse[];
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
