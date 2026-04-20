import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { isBossStarted, startBoss, stopBoss } from './queue/boss.js';

export const app = new Hono();

app.get('/health', (c) =>
  c.json({
    ok: true,
    queue: { ok: isBossStarted() },
  }),
);

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);

  await startBoss();

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[@forge/core] listening on http://localhost:${info.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[@forge/core] ${signal} received, shutting down`);
    try {
      await stopBoss();
    } finally {
      server.close();
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
