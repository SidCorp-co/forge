
export const CORE_URL = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/api\/?$/, "");

export function coreFileUrl(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${CORE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
