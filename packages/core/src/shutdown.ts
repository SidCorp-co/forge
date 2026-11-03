// How core winds down on SIGTERM or SIGINT. The composition root names the steps; this file owns
// their order and the budget they run in.
//
// HTTP drains first: from the signal on, a new request is answered 503 with Retry-After by the
// drain (lib/drain.ts) and a request already in flight finishes while everything it uses still
// runs. Then the services stop, then the listener closes, and the database goes last (ISS-930).

import { coreDrain } from './lib/drain.js';
import { logger } from './lib/logger.js';

/**
 * Core's own budget, and the part of it HTTP requests in flight may take. A deploy stops the old
 * container with a grace that must exceed `timeoutMs`, or a write that committed is killed before
 * it answers: `stop_grace_period` in both compose files (scripts/check-stop-grace.mjs holds them
 * over it), and Coolify's own stop on a deploy, which is 30 s unless the application sets one.
 */
export const SHUTDOWN_LIMITS = { httpDrainMs: 15_000, timeoutMs: 25_000 };

/** One thing core tears down on its way out, named so a slow one can be told apart in the log. */
export type ShutdownStep = { name: string; run: () => Promise<void> };

/** What core tears down: the services it runs beside HTTP, and the database, which goes last. */
export type ShutdownSteps = { services: ShutdownStep[]; database: ShutdownStep };

type Listener = {
  close: (cb?: (err?: Error) => void) => void;
  closeAllConnections?: () => void;
};

const after = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(value), ms);
    t.unref?.();
  });

export async function runShutdown(
  signal: string,
  server: Listener,
  steps: ShutdownSteps,
  limits: typeof SHUTDOWN_LIMITS = SHUTDOWN_LIMITS,
): Promise<number> {
  logger.info({ signal, inFlight: coreDrain.inFlight() }, '@forge/core shutdown initiated');
  coreDrain.begin();

  const sequence = (async () => {
    const drained = await Promise.race([
      coreDrain.settled().then(() => true),
      after(limits.httpDrainMs, false),
    ]);
    if (!drained) {
      logger.error(
        { inFlight: coreDrain.inFlight(), httpDrainMs: limits.httpDrainMs },
        '@forge/core shutdown: requests still in flight past the drain bound are cut',
      );
    }
    for (const step of steps.services) await step.run();
    // the listener stays open until here so a request arriving meanwhile is answered 503 by the
    // drain; closed, the proxy's next connection is refused and it answers 502
    const closed = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server.closeAllConnections?.();
    await closed;
    await steps.database.run();
  })();

  const outcome = await Promise.race([
    sequence.then(
      () => 'ok' as const,
      (err: unknown) => {
        logger.error({ err }, '@forge/core shutdown step failed, forcing exit');
        return 'failed' as const;
      },
    ),
    after(limits.timeoutMs, 'timeout' as const),
  ]);
  if (outcome === 'failed') return 1;
  if (outcome === 'timeout') {
    logger.error({ timeoutMs: limits.timeoutMs }, '@forge/core shutdown timed out, forcing exit');
    return 1;
  }
  return 0;
}
