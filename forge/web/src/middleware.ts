import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_ROUTES = ['/', '/login', '/register'];

// Mirror of top-level protected segments under src/app/ (incl. (protected) group children).
// Unknown paths fall through to Next.js so not-found.tsx renders with a real 404.
const PROTECTED_PREFIXES = [
  '/admin',
  '/ceo',
  '/chat-logs',
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
    if (jwt) {
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
