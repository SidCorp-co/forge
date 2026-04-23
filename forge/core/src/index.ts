import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { isBossStarted, startBoss, stopBoss } from './queue/boss.js';
import { attachWs, closeWs, isWsListening } from './ws/server.js';

export const app = new Hono();

app.get('/health', async (c) => {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const queueOk = isBossStarted();
  const wsOk = isWsListening();
  const allOk = dbOk && queueOk && wsOk;

  return c.json(
    {
      ok: allOk,
      db: { ok: dbOk },
      queue: { ok: queueOk },
      ws: { ok: wsOk },
    },
    allOk ? 200 : 503,
  );
});

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = env.PORT;

  await startBoss();

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[@forge/core] listening on http://localhost:${info.port}`);
  });

  // serve() is typed as a union that includes http2 variants, but we use the
  // default HTTP/1 server. Narrow for ws's WebSocketServer which only accepts
  // http/https servers.
  attachWs(server as unknown as HttpServer);

  const shutdown = async (signal: string) => {
    console.log(`[@forge/core] ${signal} received, shutting down`);
    try {
      await closeWs();
      await stopBoss();
    } finally {
      server.close();
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
