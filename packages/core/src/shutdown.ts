// How core winds down on SIGTERM or SIGINT. The composition root names the steps; this file owns
// their order and the budget they run in.
//
// HTTP drains first: from the signal on, a new request is answered 503 with Retry-After by the
// drain (lib/drain.ts) and a request already in flight finishes while everything it uses still
// runs. The listener stays open, answering 503, until the proxy in front can have stopped routing
// to this container; then the services stop, then the listener closes, and the database goes last
// (ISS-930).

import { coreDrain } from './lib/drain.js';
import { logger } from './lib/logger.js';

/**
 * Core's own budget, and the parts of it HTTP takes. A deploy stops the old container with a grace
 * that must exceed `timeoutMs`, or a write that committed is killed before it answers:
 * `stop_grace_period` in both compose files, and Coolify's own stop on a deploy, which is 30 s
 * unless the application sets one (shutdown-grace.test.ts holds both over it).
 *
 * `deregisterMs` is how long core keeps its listener open after SIGTERM. Traefik reads Docker's
 * events, so it routes to the old container until the container's healthcheck reads it unhealthy
 * (or it dies) and then for up to its provider throttle (2 s) more; a listener closed before that
 * is a refused connection, which Traefik answers 502. `/health` answers 503 from the signal on, so
 * the compose healthcheck's interval x retries + timeout + the throttle has to fit inside it
 * (shutdown-grace.test.ts holds them).
 */
export const SHUTDOWN_LIMITS = { deregisterMs: 10_000, httpDrainMs: 15_000, timeoutMs: 25_000 };

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

  // only a container stop has a proxy routing to it; SIGINT is a terminal's stop, with none in front
  const deregisterMs = signal === 'SIGTERM' ? limits.deregisterMs : 0;

  const sequence = (async () => {
    const [drained] = await Promise.all([
      Promise.race([coreDrain.settled().then(() => true), after(limits.httpDrainMs, false)]),
      after(deregisterMs, undefined),
    ]);
    if (!drained) {
      logger.error(
        { inFlight: coreDrain.inFlight(), httpDrainMs: limits.httpDrainMs },
        '@forge/core shutdown: requests still in flight past the drain bound are cut',
      );
    }
    for (const step of steps.services) await step.run();
    // the listener stays open until here so a request arriving meanwhile, on a new connection or a
    // kept-alive one, is answered 503 by the drain and its socket closed after; by now the proxy
    // has stopped routing here, so cutting the idle sockets left cuts no request
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
