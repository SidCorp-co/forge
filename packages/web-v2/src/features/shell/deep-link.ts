'use client';

// Deep-link helpers shared by the pin system, recents, and "Copy link".
//
// basePath is `/v2` (next.config). `next/link` / `router.push` auto-prefix it,
// so INTERNAL hrefs stored in pins/recents must stay basePath-relative. A
// shareable absolute URL, however, must include `/v2` to land back in the app.
const BASE_PATH = '/v2';

/** Absolute, shareable URL for a basePath-relative `pathname + ?query`. */
export function buildShareLink(pathWithQuery: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  return `${origin}${BASE_PATH}${path}`;
}

type FilterValue = string | number | boolean | null | undefined;

/**
 * Encode a flat filter object into a query string (leading `?`), skipping empty
 * / default-ish values so a clean view yields no query. Stable key order keeps
 * the resulting deep-link comparable.
 */
export function encodeFilters(filters: Record<string, FilterValue>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(filters).sort()) {
    const v = filters[key];
    if (v === null || v === undefined || v === '' || v === false) continue;
    params.set(key, String(v));
  }
  const q = params.toString();
  return q ? `?${q}` : '';
}

/** Read a single typed filter back from URL search params with a fallback. */
export function decodeFilter<T extends string>(
  params: URLSearchParams | null,
  key: string,
  fallback: T,
): T {
  const raw = params?.get(key);
  return (raw ?? fallback) as T;
}

/** Read a numeric filter (e.g. page) back from URL search params. */
export function decodeNumber(
  params: URLSearchParams | null,
  key: string,
  fallback: number,
): number {
  const raw = params?.get(key);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
