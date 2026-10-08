
import { NextResponse, type NextRequest } from "next/server";
import type { OperatorWhoamiResult } from "../types";
import { SESSION_ENDED_LOGIN, fetchOperatorWhoami } from "./whoami-fetch";

type OperatorGateDecision = { kind: "redirect"; to: string } | { kind: "render" };

function operatorGateDecision(result: OperatorWhoamiResult): OperatorGateDecision {
  if (result.kind === "session-ended") return { kind: "redirect", to: SESSION_ENDED_LOGIN };
  if (result.kind === "not-admin") return { kind: "redirect", to: "/" };
  return { kind: "render" };
}

export async function operatorGate(request: NextRequest): Promise<NextResponse> {
  const decision = operatorGateDecision(await fetchOperatorWhoami(request.headers.get("cookie")));
  if (decision.kind === "render") return NextResponse.next();

  const url = request.nextUrl.clone();
  const [pathname, search = ""] = decision.to.split("?");
  url.pathname = pathname ?? decision.to;
  url.search = search ? `?${search}` : "";
  return NextResponse.redirect(url);
}
