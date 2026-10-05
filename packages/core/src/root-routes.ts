import { Hono } from 'hono';
import { z } from 'zod';
import { env } from './lib/env.js';
import { rawBody, zValidator } from './middleware/zod-validator.js';

export const mcpMessageBody = rawBody(
  'application/json',
  'A JSON-RPC 2.0 message to the MCP streamable-HTTP transport; the tools it may call are the ones forge-mcp.tools.json describes.',
);

export const mcpNoBody = rawBody(
  'application/json',
  'No body is expected: the MCP streamable-HTTP transport takes the request whole, for its headers and session.',
  { required: false },
);

export const rootRoutes = new Hono();

rootRoutes.get('/pair', zValidator('query', z.object({ code: z.string().optional() })), (c) => {
  const { code } = c.req.valid('query');
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  return c.redirect(code ? `${base}/pair?code=${encodeURIComponent(code)}` : `${base}/pair`, 302);
});
