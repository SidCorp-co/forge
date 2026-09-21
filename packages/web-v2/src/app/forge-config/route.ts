
import packageJson from '../../../package.json' with { type: 'json' };

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
