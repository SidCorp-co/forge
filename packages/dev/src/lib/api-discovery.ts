/**
 * Server discovery for the desktop client.
 *
 * The user types ONE URL — the same one they paste into a browser. That
 * URL is usually the web origin, which on subdomain-split deploys is a
 * different host than the API. We probe `/.well-known/forge-config.json`
 * (Matrix client-server discovery pattern, RFC 8615) on the user-typed
 * URL to learn the actual API origin. The web app exposes this endpoint;
 * see `packages/web-v2/src/app/forge-config/route.ts`.
 *
 * Fallback ladder (mirrors the Matrix spec's IGNORE → FAIL_ERROR semantics
 * but lenient by default — a wrong answer just means "no GitHub button"):
 *
 *   - 200 + valid JSON with absolute `apiUrl`  → use apiUrl
 *   - 404 / network error / parse error / etc → fall back to user-typed URL
 *
 * Single-origin deploys (web + API on same host) need zero config: the
 * endpoint may exist and return `apiUrl == userUrl`, or may not exist
 * (older web build) — either way the desktop talks to the right host.
 */

interface ForgeConfig {
  apiUrl?: unknown;
  wsUrl?: unknown;
  version?: unknown;
}

const DISCOVERY_TIMEOUT_MS = 3000;
// Per-input cache of the resolution promise. Same input → identical
// promise → no duplicate network probe across concurrent callers.
const cache = new Map<string, Promise<string>>();

function normalize(url: string): string {
  return url.replace(/\/+$/, '');
}

async function probe(base: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/.well-known/forge-config.json`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return base;
    const data = (await res.json()) as ForgeConfig;
    if (typeof data.apiUrl !== 'string') return base;
    if (!/^https?:\/\//i.test(data.apiUrl)) return base;
    return normalize(data.apiUrl);
  } catch {
    return base;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the API origin for a given user-facing URL. Returns the user-
 * facing URL itself if discovery fails — single-origin deploys keep
 * working with zero configuration.
 *
 * Result is cached per input until `clearApiCache()` is called.
 */
export function resolveApiBase(userUrl: string): Promise<string> {
  const base = normalize(userUrl);
  if (!base) return Promise.resolve(base);
  let p = cache.get(base);
  if (!p) {
    p = probe(base);
    cache.set(base, p);
  }
  return p;
}

/** Drop cached discovery results (e.g. when the user changes the Server URL). */
export function clearApiCache(): void {
  cache.clear();
}
