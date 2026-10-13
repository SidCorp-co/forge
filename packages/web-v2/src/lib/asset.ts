// the base Vite builds under (WEB_V2_BASE_PATH), without its trailing slash
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function assetPath(path: string): string {
  return `${BASE}${path}`;
}
