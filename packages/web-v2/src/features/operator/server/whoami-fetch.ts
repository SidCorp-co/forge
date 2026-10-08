/* Status -> verdict mapping for the /admin gate. Split out of whoami.ts so the
   route middleware can reuse the exact same mapping: middleware runs in the
   edge runtime, where importing next/headers is a build error. */

import { resolveServerApiBase } from "@/lib/utils/server-api-base";
import type { OperatorWhoamiResult } from "../types";

export const AUTH_COOKIE_NAME = "forge_auth";

/** Where a session core no longer honours is sent; the login page shows the one quiet line. */
export const SESSION_ENDED_LOGIN = "/login?session=ended";

/**
 * Every `forge_auth` pair a request's `Cookie` header carries, in the order the browser sent them,
 * re-emitted as a `Cookie` header for core. A browser keeps one cookie per (name, domain, path), so
 * a web host can be sent two: its own, and a sibling instance's parent-domain one. A framework
 * cookie jar keeps one of them; the web side never picks — core tries each in order
 * (core credentials/cookie.ts:cookieValues) and decides. Null when the header carries none.
 */
export function authCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const pairs: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== AUTH_COOKIE_NAME) continue;
    const value = pair.slice(eq + 1).trim();
    if (value) pairs.push(`${AUTH_COOKIE_NAME}=${value}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : null;
}

/**
 * The verdict for the cookies this web host was sent. On split hosts (web on one origin, core on
 * another) a host-only cookie core set for its own origin never reaches the web host, so none
 * visible is `undetermined`, not signed out: the browser, which does hold it, asks core itself.
 */
export async function fetchOperatorWhoami(
  cookieHeader: string | null | undefined,
): Promise<OperatorWhoamiResult> {
  const cookie = authCookieHeader(cookieHeader);
  if (!cookie) return { kind: "undetermined" };

  try {
    const res = await fetch(`${resolveServerApiBase()}/admin/whoami`, {
      headers: { Cookie: cookie },
      cache: "no-store",
    });
    if (res.status === 401) return { kind: "session-ended" };
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
