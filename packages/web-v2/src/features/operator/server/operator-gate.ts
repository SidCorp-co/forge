
import { NextResponse, type NextRequest } from "next/server";
import type { OperatorWhoamiResult } from "../types";
import { AUTH_COOKIE_NAME, fetchOperatorWhoami } from "./whoami-fetch";

export type OperatorGateDecision = { kind: "redirect"; to: string } | { kind: "render" };

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
