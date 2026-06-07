import { useAuthStore } from "@/stores/auth-store";

// `request()` and the URL helpers below read coreUrl + token from the auth
// state machine — there is intentionally no module-level mutable auth state
// here. The pre-v0.1.28 design held `let baseUrl, authToken` at module scope
// and depended on `useLocalConfig` calling `configureApi()` before any
// component subscribed to the store could fire a request. A reorder in that
// hook silently shipped the v0.1.25 logout-on-reload race; the state machine
// makes the reorder impossible by removing the second source of truth.

function snapshotAuth(): { coreUrl: string | null; token: string | null; phase: string } {
  const s = useAuthStore.getState();
  if (s.phase === "authenticated") return { coreUrl: s.coreUrl, token: s.token, phase: s.phase };
  if (s.phase === "expired") return { coreUrl: s.coreUrl, token: null, phase: s.phase };
  if (s.phase === "unauthenticated") return { coreUrl: s.coreUrl, token: null, phase: s.phase };
  return { coreUrl: null, token: null, phase: s.phase };
}

/** Resolve a media URL — returns absolute URL for both relative and absolute inputs. */
export function coreMediaUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const { coreUrl } = snapshotAuth();
  return `${coreUrl ?? ""}${url}`;
}

const AUTH_FAIL_CODES = new Set(["INVALID_TOKEN", "UNAUTHENTICATED"]);

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { coreUrl, token, phase } = snapshotAuth();
  if (phase !== "authenticated" || !coreUrl || !token) {
    throw new Error(`API not configured: request in phase ${phase}`);
  }
  const base = coreUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
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
        if (body && typeof body === "object") {
          code = (body as { code?: string }).code;
          message = (body as { message?: string }).message ?? message;
        }
      } catch {
        // non-JSON body — keep statusText
      }
      if (!code || AUTH_FAIL_CODES.has(code)) {
        // Schedule on next tick so the caller still observes the throw before
        // the auth state flips to expired and any subscribed component
        // navigates away. The store's `expire()` action drives the keychain
        // wipe + Sentry breadcrumb; client.ts no longer holds a callback.
        queueMicrotask(() => useAuthStore.getState().expire());
      }
      throw new Error(`API error: 401 ${message}`);
    }
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return json.data ?? json;
}

/**
 * Compat shim — returns the current API origin from the auth state machine.
 * Used by `lib/api/jobs.ts` (device-token fetch) and `lib/api/misc.ts` (raw
 * upload + knowledge ingest). These callsites run inside `<RequireAuth>` so
 * the read normally lands in `authenticated`. Returns the cached coreUrl in
 * `expired` / `unauthenticated` so a background heartbeat doesn't crash on
 * a transient state flip; falls back to "" in `hydrating`.
 */
export function getBaseUrl(): string {
  const s = useAuthStore.getState();
  if (s.phase === "authenticated" || s.phase === "expired") return s.coreUrl;
  if (s.phase === "unauthenticated") return s.coreUrl ?? "";
  return "";
}

/** Compat shim — returns the user JWT only when phase === 'authenticated'. */
export function getAuthToken(): string {
  const s = useAuthStore.getState();
  return s.phase === "authenticated" ? s.token : "";
}

// --- Project slug → id resolver -------------------------------------------------
// packages/core endpoints take projectId (uuid). The dev app's URLs and stores still
// use slug. Cache the slug→id mapping in memory; refetch once on miss before
// giving up so a freshly-created project resolves without a hard reload.

let projectIdCache: Map<string, string> | null = null;

async function fetchProjectIndex(): Promise<Map<string, string>> {
  const rows = await request<Array<{ id: string; slug: string }>>("/projects");
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
 * shape on `id` is the same lie that web-v2's agents api uses.
 */
export function adaptRow<T extends { id: string }>(row: T): T & { documentId: string } {
  return { ...row, id: row.id as unknown as number, documentId: row.id } as unknown as T & {
    documentId: string;
  };
}
