import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import { outboundCall } from '../db/query-timing.js';

/**
 * Every outbound HTTP call a request waits on, counted and timed into its `Server-Timing`
 * (`middleware/server-timing.ts`): `fetch` (undici) and `node:http` both announce each request they
 * make on a diagnostics channel, so a call is counted whichever client made it and whoever holds a
 * reference to it. A call is named by the provider the code making it declares ({@link asProvider});
 * one nobody named is `other`. Nothing of the call is kept but its provider, its count and its time.
 */

const providers = new AsyncLocalStorage<string>();

/** The provider a call made inside `fn` is counted to: `coolify`, `probe`. */
export function asProvider<T>(provider: string, fn: () => T): T {
  return providers.run(provider, fn);
}

/** Each request's close, by the request object the channel announced. */
const open = new WeakMap<object, () => void>();

function opened({ request }: { request: object }): void {
  const close = outboundCall(providers.getStore() ?? 'other');
  if (close) open.set(request, close);
}

function closed({ request }: { request: object }): void {
  const close = open.get(request);
  if (!close) return;
  open.delete(request);
  close();
}

let installed = false;

/** Subscribes the channels once a process; every request made after it is counted. */
export function timeOutboundHttp(): void {
  if (installed) return;
  installed = true;
  // fetch: created, then its body read to the end or failed
  subscribe('undici:request:create', opened as (m: unknown) => void);
  subscribe('undici:request:trailers', closed as (m: unknown) => void);
  subscribe('undici:request:error', closed as (m: unknown) => void);
  // node:http: started, then its response finished or the request failed
  subscribe('http.client.request.start', opened as (m: unknown) => void);
  subscribe('http.client.response.finish', closed as (m: unknown) => void);
  subscribe('http.client.request.error', closed as (m: unknown) => void);
}
