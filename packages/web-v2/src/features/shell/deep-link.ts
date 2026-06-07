'use client';

// Deep-link helpers shared by the pin system, recents, and "Copy link".
//
// `next/link` / `router.push` auto-prefix the basePath, so INTERNAL hrefs
// stored in pins/recents must stay basePath-relative. A shareable absolute URL,
// however, must include the basePath to land back in the app. web-v2 serves at
// root since ISS-397, so the basePath is "" unless re-prefixed via env.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Absolute, shareable URL for a basePath-relative `pathname + ?query`. */
export function buildShareLink(pathWithQuery: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  return `${origin}${BASE_PATH}${path}`;
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
