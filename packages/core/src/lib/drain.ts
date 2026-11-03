// While core shuts down it drains: a request it is already answering finishes, and a new one is
// answered 503 with Retry-After at the listener. Closing the listener instead refuses the proxy's
// next connection, which it answers as 502, and a caller cannot tell that from a write that died
// half way (ISS-930).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROBLEM_CONTENT_TYPE } from '@forge/contracts/refusal';
import { problemBody } from './refusal.js';

/** How long a refused caller waits: forge-dev answered again about 20 s after the old core stopped. */
export const DRAIN_RETRY_AFTER_SECONDS = 20;

/** The probe paths that still reach their route while draining, so they can say so themselves. */
const PROBE_PATHS = new Set(['/health', '/api/health']);

type Drain = {
  /** Wraps the server's request listener: counts each request and refuses new ones while draining. */
  gate: <Req extends IncomingMessage, Res extends ServerResponse>(
    listener: (req: Req, res: Res) => void,
  ) => (req: Req, res: Res) => void;
  /** From here on, a new request is refused 503 and only the probe paths reach their route. */
  begin: () => void;
  draining: () => boolean;
  inFlight: () => number;
  /** Resolves once every request the gate let through has been answered. */
  settled: () => Promise<void>;
};

export function createDrain(): Drain {
  let draining = false;
  let inFlight = 0;
  let waiters: Array<() => void> = [];

  const finished = () => {
    inFlight -= 1;
    if (inFlight > 0) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };

  const refuse = (res: ServerResponse) => {
    const body = problemBody(
      503,
      'CORE_DRAINING',
      `core is shutting down and takes no new request; retry after ${DRAIN_RETRY_AFTER_SECONDS} s`,
    );
    res.writeHead(503, {
      'content-type': PROBLEM_CONTENT_TYPE,
      'retry-after': String(DRAIN_RETRY_AFTER_SECONDS),
      connection: 'close',
    });
    res.end(JSON.stringify(body));
  };

  return {
    gate: (listener) => (req, res) => {
      if (draining && !PROBE_PATHS.has((req.url ?? '').split('?')[0] ?? '')) {
        refuse(res);
        return;
      }
      inFlight += 1;
      // `close` fires once whether the answer was sent or the socket died first
      res.once('close', finished);
      if (draining) res.setHeader('connection', 'close');
      listener(req, res);
    },
    begin: () => {
      draining = true;
    },
    draining: () => draining,
    inFlight: () => inFlight,
    settled: () =>
      inFlight === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)),
  };
}

/** The one drain core's server runs behind; `/health` reads it and `runShutdown` begins it. */
export const coreDrain = createDrain();
