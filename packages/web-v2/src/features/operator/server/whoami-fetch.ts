/* Status -> verdict mapping for the /admin gate. Split out of whoami.ts so the
   route middleware can reuse the exact same mapping: middleware runs in the
   edge runtime, where importing next/headers is a build error. */

import type { OperatorWhoamiResult } from "../types";

export const AUTH_COOKIE_NAME = "forge_auth";

function resolveApiBase(): string {
  const base =
    process.env.NEXT_PUBLIC_API_URL ||
    (process.env.E2E_CORE_PROXY_URL ? `${process.env.E2E_CORE_PROXY_URL}/api` : null) ||
    "http://localhost:8080/api";
  return base.replace(/\/+$/, "");
}

// cm:edge contract -> packages/core/src/admin/routes.ts — GET /api/admin/whoami answers {isAdmin,email} instead of 403ing, and its 403s carry `code` (EMAIL_NOT_VERIFIED from assertEmailVerified vs ADMIN_ONLY)
export async function fetchOperatorWhoami(
  token: string | undefined,
): Promise<OperatorWhoamiResult> {
  if (!token) return { kind: "unauthenticated" };

  try {
    const res = await fetch(`${resolveApiBase()}/admin/whoami`, {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
      cache: "no-store",
    });
    if (res.status === 401) return { kind: "unauthenticated" };
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      return body?.code === "EMAIL_NOT_VERIFIED" ? { kind: "unverified" } : { kind: "not-admin" };
    }
    if (!res.ok) return { kind: "error", message: `Request failed (${res.status})` };

    const body = (await res.json()) as { isAdmin: boolean; email: string };
    return body.isAdmin ? { kind: "admin", email: body.email } : { kind: "not-admin" };
  } catch {
    return { kind: "error", message: "Couldn't reach the server. Check your connection and retry." };
  }
}
