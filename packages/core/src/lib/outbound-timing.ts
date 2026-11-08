import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { subscribe } from 'node:diagnostics_channel';
import { currentLegName, outboundCall } from '../db/query-timing.js';
import { logger } from './logger.js';
import { webBaseUrl } from './web-base-url.js';

/**
 * Every outbound HTTP call a request waits on, counted and timed into its `Server-Timing`
 * (`middleware/server-timing.ts`): `fetch` (undici) and `node:http` both announce each request they
 * make on a diagnostics channel, so a call is counted whichever client made it and whoever holds a
 * reference to it. A call is named by the provider the code making it declares ({@link asProvider});
 * one nobody named is named by the kind of host it went to ({@link hostKindOf}), and the code that
 * made it, the part of the request it was made in and its host's name are logged once a process
 * ({@link logSite}), for an operator alone.
 * The response carries nothing of the call but that kind, its count and its time: never its
 * address, path or headers.
 */

const providers = new AsyncLocalStorage<string>();

/** The provider a call made inside `fn` is counted to: `coolify`, `probe`. */
export function asProvider<T>(provider: string, fn: () => T): T {
  return providers.run(provider, fn);
}

function ownHost(): string | null {
  try {
    const base = webBaseUrl();
    return base ? new URL(base).hostname : null;
  } catch {
    return null;
  }
}

/**
 * The kind of host `hostname` is, as a leg may name it: `local` for a loopback one, `self` for this
 * Forge's own address, or `host-` and four hex of the name, which tells two hosts apart without
 * naming either; the log of the call's site names it ({@link logSite}).
 */
export function hostKindOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return 'local';
  if (host === ownHost()) return 'self';
  return `host-${createHash('sha1').update(host).digest('hex').slice(0, 4)}`;
}

function hostnameOf(request: { origin?: unknown; host?: unknown }): string {
  try {
    if (typeof request.origin === 'string') return new URL(request.origin).hostname;
  } catch {
    // an origin that does not parse is no host to name
  }
  return typeof request.host === 'string' ? request.host.split(':')[0] || 'unknown' : 'unknown';
}

/** The code frames of a stack, past this file: names and files, never an address. */
function siteOf(stack: string | undefined): string {
  return (stack ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(
      (l) =>
        /\/(src|dist)\//.test(l) && !l.includes('outbound-timing') && !l.includes('node_modules'),
    )
    .slice(0, 8)
    .map((l) =>
      l
        .replace(/^at /, '')
        .replace(/\(?\S*?\/(?:packages\/core\/)?((?:src|dist)\/[^:)]+):(\d+):\d+\)?/, '$1:$2'),
    )
    .join(' < ');
}

/** Each kind and code site logged already: the first of each once a process. */
const logged = new Set<string>();
const LOGGED_MOST = 200;

/**
 * Logs once a process which code made a call no provider names, and the host it went to (a name,
 * never a path or a query), so the leg a response names reads as its caller in the server's log.
 */
function logSite(kind: string, host: string, site: string | undefined): void {
  const part = currentLegName() ?? 'unnamed';
  const key = `${kind} ${part} ${site ?? ''}`;
  if (logged.has(key) || logged.size >= LOGGED_MOST) return;
  logged.add(key);
  logger.info(
    { kind, host, part, site: site ?? 'unknown' },
    'an outbound call a request waited on, by no named provider',
  );
}

/** Each request's close, by the request object the channel announced. */
const open = new WeakMap<object, () => void>();

function opened({ request }: { request: { origin?: unknown; host?: unknown } }): void {
  const named = providers.getStore();
  const host = hostnameOf(request);
  const kind = named ?? hostKindOf(host);
  const close = outboundCall(kind);
  if (!close) return;
  open.set(request, close);
  if (named === undefined)
    // `node:http` announces a request inside its caller's stack; fetch announces it past every await
    logSite(kind, host, siteOf(new Error().stack) || undefined);
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
