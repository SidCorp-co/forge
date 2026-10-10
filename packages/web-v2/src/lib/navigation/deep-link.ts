'use client';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Absolute, shareable URL for a basePath-relative `pathname + ?query`. */
export function buildShareLink(pathWithQuery: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  return `${origin}${BASE_PATH}${path}`;
}

