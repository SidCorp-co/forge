import { cookies } from "next/headers";
import type { OperatorWhoamiResult } from "../types";

const AUTH_COOKIE_NAME = "forge_auth";

function resolveApiBase(): string {
  const base =
    process.env.NEXT_PUBLIC_API_URL ||
    (process.env.E2E_CORE_PROXY_URL ? `${process.env.E2E_CORE_PROXY_URL}/api` : null) ||
    "http://localhost:3000/api";
  return base.replace(/\/+$/, "");
}

// cm:guard never re-export this from features/operator/index.ts — next/headers is RSC-only and would leak into the client bundle graph
export async function getOperatorWhoami(): Promise<OperatorWhoamiResult> {
  const jar = await cookies();
  const token = jar.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return { kind: "unauthenticated" };

  try {
    const res = await fetch(`${resolveApiBase()}/admin/whoami`, {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
      cache: "no-store",
    });
    if (res.status === 401) return { kind: "unauthenticated" };
    if (res.status === 403) return { kind: "not-admin" };
    if (!res.ok) return { kind: "error", message: `Request failed (${res.status})` };

    const body = (await res.json()) as { isAdmin: boolean; email: string };
    return body.isAdmin ? { kind: "admin", email: body.email } : { kind: "not-admin" };
  } catch {
    return { kind: "error", message: "Couldn't reach the server. Check your connection and retry." };
  }
}
