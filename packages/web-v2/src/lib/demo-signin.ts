// Forge previewing itself on demo data (`pnpm preview:demo`, REQ-39 / REQ-41 BC-14, BC-21): the
// demo web signs its one seeded member in on the SERVER. Every /api request it proxies to the demo
// core carries that member's credential, taken from the demo core's own `GET /api/auth/demo`, so the
// browser holds no cookie at all and a frame on another site (Safari blocks every third-party cookie,
// Chrome never sends SameSite=Lax into one) is signed in exactly like a tab. A core that is not a
// demo core answers that route DEMO_MODE_OFF, and this refuses by name instead of serving unsigned.

import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE = "forge_auth";
/** A credential this close to its end is asked for again, so a request never carries a dead one. */
const RENEW_BEFORE_MS = 60_000;

/** Whether this web server is a demo web: set by the demo stack (tests/helpers/demo-stack.ts) only. */
export const isDemoWeb = () => process.env.FORGE_DEMO_SIGNIN === "1";

interface Held {
  token: string;
  expiresAt: number;
}
let held: Held | null = null;
let asking: Promise<string> | null = null;

/** A refusal in the API's own envelope shape, so the app reads it like any other. */
function refusal(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ code, message, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

class DemoSignInRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function expiryOf(token: string): number {
  try {
    const body = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(body)) as { exp?: number };
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {}
  return Date.now() + 10 * 60_000;
}

async function signIn(core: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${core}/api/auth/demo`, { redirect: "manual", cache: "no-store" });
  } catch (err) {
    throw new DemoSignInRefused("DEMO_CORE_UNREACHABLE", `the demo core at ${core} did not answer: ${(err as Error).message}`);
  }
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  if (!cookie) {
    const body = await res.text().catch(() => "");
    throw new DemoSignInRefused(
      "DEMO_SIGNIN_REFUSED",
      `the demo core answered ${res.status} on /api/auth/demo and set no ${AUTH_COOKIE}; it must run with FORGE_DEMO_MODE=1 and a seeded demo member${body ? ` (${body.slice(0, 160)})` : ""}`,
    );
  }
  const token = cookie.slice(AUTH_COOKIE.length + 1).split(";")[0] ?? "";
  held = { token, expiresAt: expiryOf(token) };
  return token;
}

async function credential(core: string): Promise<string> {
  if (held && held.expiresAt - Date.now() > RENEW_BEFORE_MS) return held.token;
  asking ??= signIn(core).finally(() => {
    asking = null;
  });
  return asking;
}

/** The request's headers with the browser's cookies replaced by the demo member's credential. */
async function signedIn(request: NextRequest): Promise<{ headers: Headers } | NextResponse> {
  const core = process.env.E2E_CORE_PROXY_URL;
  if (!core) {
    return refusal(500, "DEMO_CORE_UNSET", "FORGE_DEMO_SIGNIN=1 needs E2E_CORE_PROXY_URL, the demo core this web proxies /api to");
  }
  try {
    const headers = new Headers(request.headers);
    headers.set("cookie", `${AUTH_COOKIE}=${await credential(core)}`);
    return { headers };
  } catch (err) {
    if (err instanceof DemoSignInRefused) return refusal(502, err.code, err.message);
    throw err;
  }
}

/** A demo web's /api request, sent on to the demo core as the demo member. Null: not a demo web. */
export async function demoApi(request: NextRequest): Promise<NextResponse | null> {
  if (!isDemoWeb()) return null;
  const { pathname, search } = request.nextUrl;
  // the browser never asks the core to sign it in: the server did, and holds the credential
  if (pathname === "/api/auth/demo") {
    return refusal(404, "DEMO_SIGNIN_IS_SERVER_SIDE", "a demo web signs its member in on the server; there is no browser sign-in to ask for");
  }
  const signed = await signedIn(request);
  if (signed instanceof NextResponse) return signed;
  const core = process.env.E2E_CORE_PROXY_URL as string;
  return NextResponse.rewrite(new URL(`${pathname}${search}`, core), { request: { headers: signed.headers } });
}

/** A demo web's own page-level gate (/admin) reads the demo member's session, not a browser cookie. */
export async function demoRequest(request: NextRequest): Promise<NextRequest> {
  if (!isDemoWeb()) return request;
  const signed = await signedIn(request);
  return signed instanceof NextResponse ? request : new NextRequest(request, { headers: signed.headers });
}
