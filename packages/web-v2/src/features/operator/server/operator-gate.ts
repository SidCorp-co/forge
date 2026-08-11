/* Pre-render gate for /admin, driven from src/middleware.ts.

   Middleware is the only place Next can refuse the request before anything
   renders. Gating in the async layout alone is not enough: once the parent
   Suspense boundary (root app/loading.tsx) has flushed, redirect() can no
   longer set a status and degrades to a <meta http-equiv="refresh">, and Next
   renders the page segment in parallel with the gating layout, so /admin
   markup streams to a non-admin regardless of the verdict (ISS-650 review). */

import { NextResponse, type NextRequest } from "next/server";
import type { OperatorWhoamiResult } from "../types";
import { AUTH_COOKIE_NAME, fetchOperatorWhoami } from "./whoami-fetch";

export type OperatorGateDecision = { kind: "redirect"; to: string } | { kind: "render" };

// cm:why unverified/error render rather than redirect — the gate's own failure must reach the user as ErrorState + Retry (the RSC layout owns those two branches), not a silent bounce
export function operatorGateDecision(result: OperatorWhoamiResult): OperatorGateDecision {
  if (result.kind === "unauthenticated") return { kind: "redirect", to: "/login" };
  if (result.kind === "not-admin") return { kind: "redirect", to: "/" };
  return { kind: "render" };
}

export async function operatorGate(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const decision = operatorGateDecision(await fetchOperatorWhoami(token));
  if (decision.kind === "render") return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = decision.to;
  url.search = "";
  return NextResponse.redirect(url);
}
