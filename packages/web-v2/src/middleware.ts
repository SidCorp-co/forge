import { NextResponse, type NextRequest } from "next/server";
import { GUIDE_PATH_HEADER } from "@/features/guides/requested-path";
import { operatorGate } from "@/features/operator/server/operator-gate";

export const config = { matcher: ["/admin", "/admin/:path*", "/guides/:path*"] };

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // `/guides` is public and is NOT gated here. The only thing this pass does is
  // carry the requested path forward, because a `not-found.tsx` cannot read it.
  if (pathname.startsWith("/guides")) {
    const headers = new Headers(request.headers);
    headers.set(GUIDE_PATH_HEADER, pathname);
    return NextResponse.next({ request: { headers } });
  }
  return operatorGate(request);
}
