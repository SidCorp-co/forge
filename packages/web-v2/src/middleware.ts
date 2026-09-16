/* Next reads `middleware` + a statically-analysable `config` only from this
   exact path, so this file is the adapter and the gate itself lives in
   features/operator — the module that owns the whole operator surface. */

import type { NextRequest } from "next/server";
import { operatorGate } from "@/features/operator/server/operator-gate";

export const config = { matcher: ["/admin", "/admin/:path*"] };

export function middleware(request: NextRequest) {
  return operatorGate(request);
}
