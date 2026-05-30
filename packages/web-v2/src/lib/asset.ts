/**
 * Prefix a public asset path with the deploy base path. Next.js auto-prefixes
 * next/image, next/link and imported assets — but NOT plain `<img src="/…">`
 * strings, so under `basePath: '/v2'` those would 404. Set
 * `NEXT_PUBLIC_BASE_PATH` to mirror `WEB_V2_BASE_PATH` in the /v2 deploy.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function assetPath(path: string): string {
  return `${BASE}${path}`;
}
