import { NextResponse, type NextRequest } from "next/server";
import { HELP_SLUGS } from "@/features/docs/help-slugs.generated";
import { FLIGHT_SIGNAL_HEADERS, isFlightRequest } from "@/features/guides/flight-request";
import {
  missingGuideDocument,
  RETRY_AFTER_SECONDS,
  refusalDocument,
  unavailableDocument,
} from "@/features/guides/missing-document";
import { readPublicRequest } from "@/features/guides/requested-page";
import {
  GUIDE_PATH_HEADER,
  GUIDE_SLUG,
  slugFromGuidePath,
} from "@/features/guides/requested-path";
import { operatorGate } from "@/features/operator/server/operator-gate";
import { resolveServerApiBase } from "@/lib/utils/server-api-base";

export const config = { matcher: ["/admin", "/admin/:path*", "/guides/:path*"] };

/** The status core answers `path` with, its body unread; `null` where core could not be reached. */
async function coreStatus(path: string): Promise<number | null> {
  try {
    const res = await fetch(`${resolveServerApiBase()}${path}`, { headers: { accept: "application/json" } });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

/** Answers a `/guides/<slug>` naming no guide, and a `/guides?path=`/`?for=` naming no page or
 *  door, with a 404, and any of them whose guides core cannot answer for with a 503; it gates
 *  nobody on those routes — why it is here and not in the page: docs/modules/guides/public-pages.md. */
async function guides(request: NextRequest, pathname: string): Promise<NextResponse> {
  const headers = new Headers(request.headers);
  headers.set(GUIDE_PATH_HEADER, pathname);
  const pass = () => NextResponse.next({ request: { headers } });

  if (isFlightRequest(request.headers)) return pass();
  const notFound = (html: string) =>
    new NextResponse(html, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", vary: FLIGHT_SIGNAL_HEADERS },
    });

  const unavailable = () =>
    new NextResponse(unavailableDocument(), {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": String(RETRY_AFTER_SECONDS),
        vary: FLIGHT_SIGNAL_HEADERS,
      },
    });
  const ok = (status: number | null) => status !== null && status >= 200 && status < 300;

  const slug = slugFromGuidePath(pathname);
  if (!slug) {
    const asked = readPublicRequest(request.nextUrl.searchParams, HELP_SLUGS);
    if (asked.kind === "refused") return notFound(refusalDocument(asked.refusal));
    return ok(await coreStatus("/guides")) ? pass() : unavailable();
  }

  const missing = () => notFound(missingGuideDocument(slug));

  if (!GUIDE_SLUG.test(slug)) return missing();

  // Core unreachable is not evidence that the guide does not exist, so it is a 503 and never a 404.
  // A guide's page is built from the index too, so the index answering is owed as well.
  const status = await coreStatus(`/guides/${encodeURIComponent(slug)}`);
  if (status === 404) return missing();
  return ok(status) && ok(await coreStatus("/guides")) ? pass() : unavailable();
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/guides")) return guides(request, pathname);
  return operatorGate(request);
}
