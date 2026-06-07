/**
 * Prefix a public asset path with the base path. Next.js auto-prefixes
 * next/image, next/link and imported assets — but NOT plain `<img src="/…">`
 * strings, so under a non-empty basePath those would 404. Defaults to "" to
 * mirror next.config (web-v2 serves at root since ISS-397); set
 * `NEXT_PUBLIC_BASE_PATH="/v2"` only to mirror a prefixed build.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function assetPath(path: string): string {
  return `${BASE}${path}`;
}
