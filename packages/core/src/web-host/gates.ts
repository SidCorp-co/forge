import {
  GUIDE_SLUG,
  INDEX_HREF,
  missingGuideBody,
  missingGuideHeading,
  readPublicRequest,
  refusalDocument,
  slugFromGuidePath,
} from '@forge/contracts/guide-addresses';
import { AUTH_COOKIE_NAME, cookieValues } from '../credentials/cookie.js';
import { getGuide } from '../guides/index.js';
import type { WebBuild } from './build.js';

/** This app's own fetch, so a gate asks core in-process what a browser would ask it over HTTP. */
export type AppFetch = (request: Request) => Promise<Response>;

/** What a page request is answered with before the page: a response, or null to serve the page. */
export type GateAnswer = Response | null;

const notFoundDocument = (html: string): Response =>
  new Response(html, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });

export const redirectTo = (location: string): Response =>
  new Response(null, { status: 307, headers: { location, 'cache-control': 'no-store' } });

/**
 * `/guides/<slug>` naming no guide, and `/guides?path=`/`?for=` naming no page or door, answered
 * with a 404 document before the web loads, so a crawler and a link checker read the miss as a
 * miss (docs/modules/guides/public-pages.md). The web says the same words on a navigation inside it.
 */
export function guidesGate(path: string, url: URL, origin: string, build: WebBuild): GateAnswer {
  const index = `${build.basePath}${INDEX_HREF}`;
  const slug = slugFromGuidePath(path);
  if (!slug) {
    const asked = readPublicRequest(url.searchParams, build.manifest.helpSlugs);
    return asked.kind === 'refused'
      ? notFoundDocument(refusalDocument(asked.refusal, index))
      : null;
  }
  if (GUIDE_SLUG.test(slug) && getGuide(slug)) return null;
  const refusal = {
    heading: missingGuideHeading(slug),
    body: missingGuideBody(`${origin}/api/guides`),
  };
  return notFoundDocument(refusalDocument(refusal, index));
}

/**
 * `/admin`: a session core no longer honours is sent to sign in again, and a member who is not an
 * operator is sent home, before the console loads. No credential on the request is not a verdict:
 * the console's own gate asks core from the browser.
 */
export async function operatorGate(
  cookie: string | undefined,
  url: URL,
  fetch: AppFetch,
  basePath: string,
): Promise<GateAnswer> {
  const values = cookieValues(cookie, AUTH_COOKIE_NAME);
  if (values.length === 0) return null;
  const res = await fetch(
    new Request(new URL('/api/admin/whoami', url), {
      headers: { cookie: values.map((v) => `${AUTH_COOKIE_NAME}=${v}`).join('; ') },
    }),
  );
  if (res.status === 401) return redirectTo(`${basePath}/login?session=ended`);
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    return body?.code === 'EMAIL_NOT_VERIFIED' ? null : redirectTo(`${basePath}/`);
  }
  if (!res.ok) return null;
  const body = (await res.json()) as { isAdmin?: boolean };
  return body.isAdmin === true ? null : redirectTo(`${basePath}/`);
}
