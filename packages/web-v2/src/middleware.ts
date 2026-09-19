
import type { NextRequest } from "next/server";
import { operatorGate } from "@/features/operator/server/operator-gate";

export const config = { matcher: ["/admin", "/admin/:path*"] };

export function middleware(request: NextRequest) {
  return operatorGate(request);
}
