let baseUrl = "http://localhost:8080";
let authToken = "";

export function configureApi(url: string, token: string) {
  baseUrl = url.replace(/\/$/, "");
  authToken = token;
  clearProjectIdCache();
}

/** Resolve a Strapi media URL — returns absolute URL for both relative and absolute inputs. */
export function strapiMediaUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${baseUrl}${url}`;
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
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
// forge/core endpoints take projectId (uuid). The dev app's URLs and stores still
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

export function clearProjectIdCache() {
  projectIdCache = null;
}

/**
 * forge/core returns flat rows keyed by `id` (uuid). The dev app's types still
 * mirror the legacy Strapi shape with `documentId: string` and `id: number`.
 * Mirror id→documentId so existing components keep working unchanged; the cast
 * shape on `id` is the same lie that forge/web's agent api.ts uses.
 */
export function adaptRow<T extends { id: string }>(row: T): T & { documentId: string } {
  return { ...row, id: row.id as unknown as number, documentId: row.id } as unknown as T & {
    documentId: string;
  };
}
