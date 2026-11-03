// How core winds down on SIGTERM or SIGINT. The composition root names the steps; this file owns
// their order and the budget they run in.

import { logger } from './lib/logger.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

/** One thing core tears down on its way out, named so a slow one can be told apart in the log. */
export type ShutdownStep = { name: string; run: () => Promise<void> };

/** What core tears down: the services it runs beside HTTP, and the database, which goes last. */
export type ShutdownSteps = { services: ShutdownStep[]; database: ShutdownStep };

export async function runShutdown(
  signal: string,
  server: { close: (cb?: (err?: Error) => void) => void },
  steps: ShutdownSteps,
): Promise<number> {
  logger.info({ signal }, '@forge/core shutdown initiated');

  const httpClosed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  const sequence = (async () => {
    for (const step of steps.services) await step.run();
    await httpClosed;
    await steps.database.run();
  })();

  const timeout = new Promise<'timeout'>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
    t.unref?.();
  });

  const outcome = await Promise.race([sequence.then(() => 'ok' as const), timeout]);
  if (outcome === 'timeout') {
    logger.error('@forge/core shutdown timed out after 30s, forcing exit');
    return 1;
  }
  return 0;
}
