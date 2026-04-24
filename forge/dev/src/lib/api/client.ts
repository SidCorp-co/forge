let baseUrl = "http://localhost:8080";
let authToken = "";

export function configureApi(url: string, token: string) {
  baseUrl = url.replace(/\/$/, "");
  authToken = token;
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
