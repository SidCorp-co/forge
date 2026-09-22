/* Status -> verdict mapping for the /admin gate. Split out of whoami.ts so the
   route middleware can reuse the exact same mapping: middleware runs in the
   edge runtime, where importing next/headers is a build error. */

import { resolveServerApiBase } from "@/lib/utils/server-api-base";
import type { OperatorWhoamiResult } from "../types";

export const AUTH_COOKIE_NAME = "forge_auth";

export async function fetchOperatorWhoami(
  token: string | undefined,
): Promise<OperatorWhoamiResult> {
  if (!token) return { kind: "unauthenticated" };

  try {
    const res = await fetch(`${resolveServerApiBase()}/admin/whoami`, {
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
