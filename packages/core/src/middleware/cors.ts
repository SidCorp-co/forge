import { cors } from 'hono/cors';
import { env } from '../lib/env.js';
import { PAT_ACCEPTED_PERMISSIONS_HEADER } from './pat-rest-surface.js';
import { SERVER_TIMING_HEADER } from './server-timing.js';

let corsOrigins: string[] | undefined;

/** The browser origins CORS_ORIGINS admits, read on the first request rather than at import. */
export function allowedOrigins(): string[] {
  corsOrigins ??= env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return corsOrigins;
}

/** CORS for /api and /mcp: an admitted origin gets credentials and the headers a client reads. */
export const corsMiddleware = cors({
  origin: (origin) => (allowedOrigins().includes(origin) ? origin : null),
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'X-Device-Token', 'X-Forge-Project-Slug'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: [
    'X-Total-Count',
    'Retry-After',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-RateLimit-Scope',
    PAT_ACCEPTED_PERMISSIONS_HEADER,
    SERVER_TIMING_HEADER,
  ],
});
