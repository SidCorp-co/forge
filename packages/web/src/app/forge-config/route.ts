/**
 * Server discovery endpoint — exposed at `/.well-known/forge-config.json`
 * via a Next.js rewrite (see next.config.ts). Pattern follows Matrix's
 * `/.well-known/matrix/client` (RFC 8615): a desktop / native client
 * types ONE user-facing URL, then probes this endpoint to learn where
 * the API + WebSocket actually live. Lets us support both single-origin
 * and subdomain-split deploys without forcing the user to know which
 * shape the operator chose.
 *
 * Public, unauthenticated, CORS-permissive — operators may serve this
 * statically via a reverse proxy if they prefer.
 */

import packageJson from '../../../package.json' with { type: 'json' };

// `NEXT_PUBLIC_API_URL` is "<origin>/api" by convention (e.g.
// "https://forge-beta-api.sidcorp.co/api"); strip the suffix so the
// desktop client gets the origin and appends `/api/...` itself.
function getApiOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? '';
  return raw
    .replace(/\/api\/?$/, '')
    .replace(/\/+$/, '');
}

export async function GET() {
  return Response.json(
    {
      apiUrl: getApiOrigin(),
      // Optional — set NEXT_PUBLIC_WS_URL if WS lives on a different origin
      // than the API. When unset we omit the field so clients fall back to
      // their own derivation (replace http→ws on apiUrl + /ws).
      ...(process.env.NEXT_PUBLIC_WS_URL
        ? { wsUrl: process.env.NEXT_PUBLIC_WS_URL }
        : {}),
      version: packageJson.version,
    },
    {
      headers: {
        // 60s TTL is long enough to cut chatter, short enough that an
        // operator who rotates the API URL doesn't strand offline clients.
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
