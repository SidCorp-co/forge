import type { Context } from 'koa';
import { onSessionEvent } from './websocket';

/**
 * Starts an SSE stream that bridges WebSocket session events to an HTTP response.
 * Returns a cleanup function.
 */
export function startSSEStream(ctx: Context, sessionId: string): () => void {
  ctx.set('Content-Type', 'text/event-stream');
  ctx.set('Cache-Control', 'no-cache');
  ctx.set('Connection', 'keep-alive');
  ctx.set('X-Accel-Buffering', 'no');
  ctx.status = 200;
  ctx.respond = false;

  const res = ctx.res;
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
  }, 15_000);

  let cleaned = false;
  const unsubscribe = onSessionEvent(sessionId, (event, data) => {
    if (res.writableEnded || res.destroyed) return;

    let sseEvent: string;
    if (event === 'agent:message') sseEvent = 'message';
    else if (event === 'agent:complete') sseEvent = 'complete';
    else if (event === 'agent:user-message') sseEvent = 'user_message';
    else sseEvent = event.replace('agent:', '');

    try {
      res.write(`event: ${sseEvent}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* socket already destroyed */ }

    if (event === 'agent:complete') {
      cleanup();
      try { res.end(); } catch { /* ignore */ }
    }
  });

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
  }

  ctx.req.on('close', cleanup);

  return cleanup;
}
