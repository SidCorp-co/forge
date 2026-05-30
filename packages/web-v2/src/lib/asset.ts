/**
 * Prefix a public asset path with the base path. Next.js auto-prefixes
 * next/image, next/link and imported assets — but NOT plain `<img src="/…">`
 * strings, so under `basePath: '/v2'` those would 404. Defaults to `/v2` to
 * mirror next.config (no env needed); set `NEXT_PUBLIC_BASE_PATH=""` for the
 * root cutover build.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "/v2";

export function assetPath(path: string): string {
  return `${BASE}${path}`;
}
