import { serve } from '@hono/node-server';
import { Hono } from 'hono';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[@forge/core] listening on http://localhost:${info.port}`);
  });
}
