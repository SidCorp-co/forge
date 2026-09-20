import { NextResponse, type NextRequest } from "next/server";
import { missingGuideDocument } from "@/features/guides/missing-document";
import { GUIDE_PATH_HEADER, slugFromGuidePath } from "@/features/guides/requested-path";
import { operatorGate } from "@/features/operator/server/operator-gate";
import { resolveServerApiBase } from "@/lib/utils/server-api-base";

export const config = { matcher: ["/admin", "/admin/:path*", "/guides/:path*"] };

/** Answers a `/guides/<slug>` that names no guide, and does nothing else on
 *  those routes — they are public and this pass gates nobody.
 *
 *  The refusal is here rather than in the page because `notFound()` raised in a
 *  dynamic route makes Next emit its bare error document and stream the
 *  not-found body as flight data: measured on the standalone server (ISS-1124),
 *  a reader without JavaScript got the 404 status and an empty <body>. This is
 *  the only layer that can set a status and a body together.
 *
 *  A client-side navigation is left alone. The router fetches the same URL with
 *  an `RSC` header and would choke on an HTML document; it also has JavaScript
 *  by definition, so the page's own `notFound()` and `not-found.tsx` serve it. */
async function guides(request: NextRequest, pathname: string): Promise<NextResponse> {
  const headers = new Headers(request.headers);
  headers.set(GUIDE_PATH_HEADER, pathname);
  const pass = () => NextResponse.next({ request: { headers } });

  const slug = slugFromGuidePath(pathname);
  if (!slug || request.headers.has("RSC")) return pass();

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
  if (status !== 404) return pass();

  return new NextResponse(missingGuideDocument(slug), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/guides")) return guides(request, pathname);
  return operatorGate(request);
}
