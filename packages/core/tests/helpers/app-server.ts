import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';

/**
 * A live in-process core server: HTTP + WS + pg-boss dispatcher, bound to an
 * ephemeral port. Used by the Phase 2.7-F2 device-runner E2E (ISS-218) to
 * exercise the full REST + WS contract end-to-end against a real Postgres.
 *
 * Callers must set `process.env.DATABASE_URL` (and the other test-env vars in
 * `pipeline-e2e.test.ts`) BEFORE calling `startTestServer()`, because importing
 * `../../src/index.js` resolves `config/env.ts` and binds the drizzle client at
 * module-load time.
 */
export interface TestServer {
  baseUrl: string;
  wsUrl: string;
  /** Live ws clients on the server (read `.size` for dangling-socket checks). */
  openSocketCount(): number;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const [
    { app },
    { attachWs, closeWs, wsClientCount },
    { startBoss, stopBoss },
    { registerDispatcher, unregisterDispatcher },
  ] = await Promise.all([
    import('../../src/index.js'),
    import('../../src/ws/server.js'),
    import('../../src/queue/boss.js'),
    import('../../src/jobs/dispatcher.js'),
  ]);

  await startBoss();
  await registerDispatcher();

  // Node http server + Hono node-adapter on an ephemeral port.
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => {
    if ((server as { listening?: boolean }).listening) {
      resolve();
    } else {
      server.once('listening', () => resolve());
    }
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  attachWs(server as unknown as import('node:http').Server);

  return {
    baseUrl,
    wsUrl,
    openSocketCount: wsClientCount,
    async close() {
      await unregisterDispatcher();
      await stopBoss();
      await closeWs();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
