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
  '/ceo',
  '/chat-logs',
  '/connect-device',
  '/dashboard',
  '/devices',
  '/pipeline',
  '/projects',
  '/settings',
];

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

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
