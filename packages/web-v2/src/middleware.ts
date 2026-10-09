import { NextResponse, type NextRequest } from "next/server";
import { HELP_SLUGS } from "@/features/docs/help-slugs.generated";
import { missingGuideDocument, refusalDocument } from "@/features/guides/missing-document";
import { readPublicRequest } from "@/features/guides/requested-page";
import {
  GUIDE_PATH_HEADER,
  GUIDE_SLUG,
  slugFromGuidePath,
} from "@/features/guides/requested-path";
import { demoApi, demoRequest } from "@/lib/demo-signin";
import { operatorGate } from "@/features/operator/server/operator-gate";
import { resolveServerApiBase } from "@/lib/utils/server-api-base";

export const config = { matcher: ["/admin", "/admin/:path*", "/guides/:path*", "/api/:path*"] };

/** Answers a `/guides/<slug>` naming no guide, and a `/guides?path=`/`?for=` naming no page or
 *  door, and gates nobody on those routes — why it is here and not in the page:
 *  docs/modules/guides/public-pages.md. */
async function guides(request: NextRequest, pathname: string): Promise<NextResponse> {
  const headers = new Headers(request.headers);
  headers.set(GUIDE_PATH_HEADER, pathname);
  const pass = () => NextResponse.next({ request: { headers } });

  if (request.headers.has("RSC")) return pass();
  const notFound = (html: string) =>
    new NextResponse(html, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });

  const slug = slugFromGuidePath(pathname);
  if (!slug) {
    const asked = readPublicRequest(request.nextUrl.searchParams, HELP_SLUGS);
    return asked.kind === "refused" ? notFound(refusalDocument(asked.refusal)) : pass();
  }

  const missing = () => notFound(missingGuideDocument(slug));

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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/guides")) return guides(request, pathname);
  // a demo web answers /api as its seeded member, server-side (lib/demo-signin.ts); any other web
  // lets the request through to the rewrite that proxies it, or to the ingress that never sends it
  if (pathname.startsWith("/api/")) return (await demoApi(request)) ?? NextResponse.next();
  return operatorGate(await demoRequest(request));
}
