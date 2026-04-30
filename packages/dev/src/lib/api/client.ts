import { clearDeviceTokenCache } from "./jobs";

// `baseUrl` starts empty so any request fired before `configureApi` runs
// (i.e. before useLocalConfig hydrates from disk + keychain) fails loudly
// instead of silently hitting localhost:8080 — the v0.1.25 logout-on-reload
// regression was caused by an operator's local dev core at that address
// returning 401 INVALID_TOKEN to a pre-hydrate query and triggering the
// auth-expired wipe. An empty baseUrl makes the same race observable
// during dev (no fetch goes out) instead of dangerous in prod.
let baseUrl = "";
let authToken = "";

export function configureApi(url: string, token: string) {
  baseUrl = url.replace(/\/$/, "");
  authToken = token;
  clearProjectIdCache();
  // The cached device token is bound to the previous coreUrl; wipe it so we
  // don't send the old core's credentials to a newly-configured server.
  clearDeviceTokenCache();
}

/** Resolve a Strapi media URL — returns absolute URL for both relative and absolute inputs. */
export function strapiMediaUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${baseUrl}${url}`;
}

/**
 * Listener installed by app-store on boot. Fires once per request that comes
 * back 401 with `INVALID_TOKEN` / `UNAUTHENTICATED` — the store clears its
 * authToken and routes to /login. Decoupled via a callback so client.ts
 * doesn't have to import the store (avoids the React → fetch cycle).
 */
let onAuthExpired: (() => void) | null = null;
export function setAuthExpiredHandler(fn: (() => void) | null): void {
  onAuthExpired = fn;
}

const AUTH_FAIL_CODES = new Set(['INVALID_TOKEN', 'UNAUTHENTICATED']);

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (!baseUrl) {
    // Pre-hydrate request — refuse rather than silently fall back to a
    // hostname the renderer never knew about. Callers gate on configReady
    // (RequireAuth, query enabled flags); this throw is a safety net for
    // anything that slips through.
    throw new Error('API not configured: request before configureApi()');
  }
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      // Drain the body once so we can read both the code and pass a useful
      // message to the caller. Server emits `{ code, message }`; legacy
      // routes may emit free-form text — fall back gracefully.
      let code: string | undefined;
      let message = res.statusText;
      try {
        const body = await res.clone().json();
        if (body && typeof body === 'object') {
          code = (body as { code?: string }).code;
          message = (body as { message?: string }).message ?? message;
        }
      } catch {
        // non-JSON body — keep statusText
      }
      if (!code || AUTH_FAIL_CODES.has(code)) {
        // Schedule on next tick so the caller still observes the throw before
        // the page navigates away. The store handler is responsible for
        // clearing local state + redirecting.
        if (onAuthExpired) queueMicrotask(onAuthExpired);
      }
      throw new Error(`API error: 401 ${message}`);
    }
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return json.data ?? json;
}

/** Raw fetch against baseUrl (bypasses /api prefix and JSON content-type). Used by upload/knowledge. */
export function getBaseUrl() {
  return baseUrl;
}

export function getAuthToken() {
  return authToken;
}

// --- Project slug → id resolver -------------------------------------------------
// packages/core endpoints take projectId (uuid). The dev app's URLs and stores still
// use slug. Cache the slug→id mapping in memory; refetch once on miss before
// giving up so a freshly-created project resolves without a hard reload.

let projectIdCache: Map<string, string> | null = null;

async function fetchProjectIndex(): Promise<Map<string, string>> {
  const rows = await request<Array<{ id: string; slug: string }>>('/projects');
  return new Map(rows.map((p) => [p.slug, p.id]));
}

export async function resolveProjectId(slug: string): Promise<string> {
  if (!projectIdCache) projectIdCache = await fetchProjectIndex();
  let id = projectIdCache.get(slug);
  if (!id) {
    projectIdCache = await fetchProjectIndex();
    id = projectIdCache.get(slug);
    if (!id) throw new Error(`project not found: ${slug}`);
  }
  return id;
}

// Reverse lookup for dispatcher payloads which carry projectId (uuid). Reuses
// the same project index cache; refetches once on miss like resolveProjectId.
export async function resolveProjectSlug(projectId: string): Promise<string> {
  if (!projectIdCache) projectIdCache = await fetchProjectIndex();
  for (const [slug, id] of projectIdCache) if (id === projectId) return slug;
  projectIdCache = await fetchProjectIndex();
  for (const [slug, id] of projectIdCache) if (id === projectId) return slug;
  throw new Error(`project not found for id: ${projectId}`);
}

export function clearProjectIdCache() {
  projectIdCache = null;
}

/**
 * packages/core returns flat rows keyed by `id` (uuid). The dev app's types still
 * mirror the legacy Strapi shape with `documentId: string` and `id: number`.
 * Mirror id→documentId so existing components keep working unchanged; the cast
 * shape on `id` is the same lie that packages/web's agent api.ts uses.
 */
export function adaptRow<T extends { id: string }>(row: T): T & { documentId: string } {
  return { ...row, id: row.id as unknown as number, documentId: row.id } as unknown as T & {
    documentId: string;
  };
}
