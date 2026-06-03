import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// `/download` is public AND should NOT redirect logged-in users elsewhere —
// authed users still need to reach the page to grab a fresh binary or share
// the link. Listed in PUBLIC_ROUTES below but exempted from the
// authed-redirect branch via PUBLIC_NO_REDIRECT.
const PUBLIC_ROUTES = ['/', '/login', '/register', '/download'];
const PUBLIC_NO_REDIRECT = new Set(['/download']);

// Mirror of top-level protected segments under src/app/ (incl. (protected) group children).
// Unknown paths fall through to Next.js so not-found.tsx renders with a real 404.
const PROTECTED_PREFIXES = [
  '/admin',
  '/chat-logs',
  '/connect-device',
  '/dashboard',
  '/devices',
  '/pipeline',
  '/projects',
  '/settings',
];

// v1 paths whose canonical UI now lives in web-v2 (served at /v2 via the
// reverse proxy). Strangler migration: add one entry per screen as it is cut
// over to v2. Keys are matched exactly so unmigrated sibling routes are
// untouched. The redirect below only fires for authenticated users, so the
// auth gate still owns the unauthenticated case.
const V2_MIGRATED_PATHS: Record<string, string> = {
  '/dashboard': '/v2', // Overview — ISS-355 workspace dashboard
};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const jwt = request.cookies.get('forge_auth')?.value;

  if (PUBLIC_ROUTES.includes(pathname)) {
    if (jwt && !PUBLIC_NO_REDIRECT.has(pathname)) {
      return NextResponse.redirect(new URL('/projects', request.url));
    }
    return NextResponse.next();
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (isProtected && !jwt) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Per-screen v1→v2 migration: authed hits on a migrated v1 path are sent to
  // its /v2 equivalent (handed off to web-v2 by the reverse proxy). Placed
  // after the auth gate so an unauthenticated /dashboard still goes to /login.
  if (jwt && pathname in V2_MIGRATED_PATHS) {
    return NextResponse.redirect(
      new URL(V2_MIGRATED_PATHS[pathname], request.url),
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
