import { NextResponse, type NextRequest } from "next/server";
import { missingGuideDocument } from "@/features/guides/missing-document";
import {
  GUIDE_PATH_HEADER,
  GUIDE_SLUG,
  slugFromGuidePath,
} from "@/features/guides/requested-path";
import { operatorGate } from "@/features/operator/server/operator-gate";
import { resolveServerApiBase } from "@/lib/utils/server-api-base";

export const config = { matcher: ["/admin", "/admin/:path*", "/guides/:path*"] };

/** Answers a `/guides/<slug>` naming no guide, and gates nobody on those routes
 *  — why it is here and not in the page: docs/modules/guides/public-pages.md. */
async function guides(request: NextRequest, pathname: string): Promise<NextResponse> {
  const headers = new Headers(request.headers);
  headers.set(GUIDE_PATH_HEADER, pathname);
  const pass = () => NextResponse.next({ request: { headers } });

  const slug = slugFromGuidePath(pathname);
  if (!slug || request.headers.has("RSC")) return pass();

  const missing = () =>
    new NextResponse(missingGuideDocument(slug), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  if (!GUIDE_SLUG.test(slug)) return missing();

  let status: number;
  try {
    const res = await fetch(`${resolveServerApiBase()}/guides/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json" },
    });
    status = res.status;
  } catch {
    // Core unreachable: let the page make the request and fail loudly there,
    // rather than telling a reader the guide does not exist on this evidence.
    return pass();
  }
  return status === 404 ? missing() : pass();
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/guides")) return guides(request, pathname);
  return operatorGate(request);
}
