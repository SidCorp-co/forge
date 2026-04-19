import type { ForgeToolContext } from '../tools';

const SENSITIVE_FIELDS = new Set([
  "bankAccountNumber",
  "bankRoutingNumber",
  "taxId",
  "socialSecurityNumber",
  "ssn",
  "bankName",
  "iban",
  "swiftCode",
]);

/** Recursively remove sensitive fields from data */
export function stripSensitive(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(stripSensitive);
  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_FIELDS.has(key)) continue;
      result[key] = stripSensitive(value);
    }
    return result;
  }
  return data;
}

/** Build Strapi filter query string from a flat object */
export function buildFilters(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`filters[${key}][$eq]=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

/** Add pagination params */
export function paginate(page?: number, pageSize?: number): string {
  const parts: string[] = [];
  if (page) parts.push(`pagination[page]=${page}`);
  parts.push(`pagination[pageSize]=${pageSize ?? 25}`);
  return parts.join("&");
}

/** Combine query string parts, filtering empties */
export function qs(...parts: (string | undefined | null)[]): string {
  const filtered = parts.filter((p) => p && p.length > 0);
  return filtered.length > 0 ? "?" + filtered.join("&") : "";
}

/** Authenticated GET request to Strapi */
export async function strapiGet(
  baseUrl: string,
  endpoint: string,
  jwt: string | undefined,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  const res = await fetch(url, { headers, signal });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 5000);
  }
  return { ok: res.ok, status: res.status, data };
}

/** Authenticated POST/PUT request to Strapi */
export async function strapiPost(
  baseUrl: string,
  endpoint: string,
  body: unknown,
  jwt: string | undefined,
  signal: AbortSignal,
  method: "POST" | "PUT" = "POST",
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  const res = await fetch(url, { method, headers, body: JSON.stringify(body), signal });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 5000);
  }
  return { ok: res.ok, status: res.status, data };
}

/** Extract JWT from tool context */
export function getJwt(ctx: ForgeToolContext): string | undefined {
  return ctx.strapiJwt;
}

/** Format response, strip sensitive data, truncate */
export function formatResponse(data: unknown, ok: boolean, status: number): string {
  if (!ok) return `Error ${status}: ${JSON.stringify(data).slice(0, 2000)}`;
  const cleaned = stripSensitive(data);
  const json = JSON.stringify(cleaned, null, 2);
  return json.slice(0, 30000);
}
