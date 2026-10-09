// The preview host (BC-1, BC-2, BC-4): every request to `<label>.<PREVIEW_DOMAIN>` is answered here,
// before the API routes. `/__forge_preview/enter` spends a ticket for the viewer cookie; any other
// request needs that cookie, a viewer who still reads the project, and a live preview, and is then
// relayed over a tunnel stream to the dev server on the box's loopback. Node's own http client does
// the HTTP and the `101` upgrade the dev server's hot reload asks for (live-preview.md, "Tunnel").

import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import {
  PREVIEW_COOKIE,
  PREVIEW_ENTER_PATH,
  PREVIEW_LIMITS,
  PREVIEW_RESERVED_PATH,
} from '@forge/contracts/preview';
import type { PreviewRow } from '../db/schema-previews.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { labelOfHost, type PreviewSite, previewOrigin, previewSite } from './domain.js';
import {
  closedPage,
  devServerErrorPage,
  enterRefusedPage,
  notFoundPage,
  notMemberPage,
  type Page,
  sendPage,
  signInPage,
  startingPage,
  tunnelDownPage,
} from './pages.js';
import { previewBySlug } from './read.js';
import { serves } from './rules.js';
import { noteViewed, reopenForViewer } from './service.js';
import { readViewer, signViewer, spendTicket } from './ticket.js';
import { openTunnelStream, TunnelStreamError } from './tunnel.js';

/** Whether a request names a preview host: it is answered here, never by the API. */
export function isPreviewRequest(req: IncomingMessage): boolean {
  return labelOfHost(req.headers.host, previewSite()) !== null;
}

/** The server's listener with preview hosts answered by the relay before `api` sees them. */
export function withPreviewHosts<Q extends IncomingMessage, S extends ServerResponse>(
  api: ((req: Q, res: S) => void) | undefined,
): (req: Q, res: S) => void {
  return (req, res) => {
    if (isPreviewRequest(req)) void relayPreviewRequest(req, res);
    else api?.(req, res);
  };
}

const MEMBERSHIP_TTL_MS = 60_000;
const memberships = new Map<string, { member: boolean; at: number }>();

/** Whether the viewer still reads the project, asked at most once a minute per viewer (BC-4). */
async function stillMember(userId: string, projectId: string, now = Date.now()) {
  const key = `${userId}:${projectId}`;
  const held = memberships.get(key);
  if (held && now - held.at < MEMBERSHIP_TTL_MS) return held.member;
  const member = await can(actorFor(userId, 'human'), 'project.read', projectResource(projectId));
  memberships.set(key, { member, at: now });
  if (memberships.size > 10_000) memberships.clear();
  return member;
}

function cookiesOf(header: string | undefined): { viewer: string | null; rest: string | null } {
  if (!header) return { viewer: null, rest: null };
  let viewer: string | null = null;
  const rest: string[] = [];
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    const name = (at === -1 ? pair : pair.slice(0, at)).trim();
    if (name === PREVIEW_COOKIE) viewer ??= pair.slice(at + 1).trim();
    else if (pair.trim() !== '') rest.push(pair.trim());
  }
  return { viewer, rest: rest.length > 0 ? rest.join('; ') : null };
}

type Admission =
  | { ok: true; row: PreviewRow; userId: string; site: PreviewSite }
  | { ok: false; page: Page };

/** Who the request is and whether the preview serves them now; a page in Forge's words if not. */
async function admit(req: IncomingMessage, url: URL): Promise<Admission | { ok: 'enter' }> {
  const site = previewSite();
  const label = labelOfHost(req.headers.host, site);
  if (site === null || label === null) return { ok: false, page: notFoundPage() };
  const row = await previewBySlug(label);
  if (!row) return { ok: false, page: notFoundPage() };
  if (url.pathname === PREVIEW_ENTER_PATH) return { ok: 'enter' };
  if (url.pathname.startsWith(PREVIEW_RESERVED_PATH)) return { ok: false, page: notFoundPage() };
  const token = cookiesOf(req.headers.cookie).viewer;
  const grant = token === null ? null : await readViewer(token);
  if (!grant || grant.previewId !== row.id) return { ok: false, page: signInPage() };
  if (!(await stillMember(grant.userId, row.projectId)))
    return { ok: false, page: notMemberPage() };
  if (row.state === 'idle_closed') {
    return (await reopenForViewer(row, grant.userId))
      ? { ok: false, page: startingPage() }
      : { ok: false, page: closedPage(row) };
  }
  if (!serves(row.state)) return { ok: false, page: closedPage(row) };
  if (row.state === 'starting') return { ok: false, page: startingPage() };
  return { ok: true, row, userId: grant.userId, site };
}

/** Spend the ticket in the query, set the viewer cookie on this host only, and send the browser to `/`. */
async function enter(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const site = previewSite();
  const label = labelOfHost(req.headers.host, site);
  const ticket = url.searchParams.get('ticket');
  const grant = ticket === null ? null : await spendTicket(ticket);
  const row = label === null ? null : await previewBySlug(label);
  if (!grant || !row || grant.previewId !== row.id || site === null) {
    return sendPage(res, enterRefusedPage());
  }
  const viewer = await signViewer(grant);
  const secure =
    site.scheme === 'https:' ? '; Secure; SameSite=None; Partitioned' : '; SameSite=Lax';
  res.writeHead(303, {
    location: '/',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'set-cookie': `${PREVIEW_COOKIE}=${viewer}; Path=/; Max-Age=${PREVIEW_LIMITS.viewerSeconds}; HttpOnly${secure}`,
  });
  res.end();
}

const REWRITTEN = new Set(['host', 'cookie', 'origin', 'referer']);
/** One request per stream: the stream closes with its answer, so nothing asks to keep it. */
const CONNECTION = new Set(['connection', 'keep-alive', 'proxy-connection']);

/**
 * The browser's headers as the dev server should read them: its own host (Vite's `allowedHosts`
 * passes `localhost`), an origin of its own, and no Forge cookie. An upgrade keeps its `connection`.
 */
function upstreamHeaders(
  req: IncomingMessage,
  port: number,
  origin: string,
  upgrade: boolean,
): IncomingHttpHeaders {
  const local = `localhost:${port}`;
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (REWRITTEN.has(name) || value === undefined) continue;
    if (!upgrade && CONNECTION.has(name)) continue;
    headers[name] = value;
  }
  headers.host = local;
  const { rest } = cookiesOf(req.headers.cookie);
  if (rest !== null) headers.cookie = rest;
  const rewrite = (value: string | undefined) =>
    value?.startsWith(origin) ? `http://${local}${value.slice(origin.length)}` : value;
  if (req.headers.origin) headers.origin = rewrite(req.headers.origin);
  if (req.headers.referer) headers.referer = rewrite(req.headers.referer);
  headers['x-forwarded-host'] = new URL(origin).host;
  headers['x-forwarded-proto'] = new URL(origin).protocol.replace(':', '');
  return headers;
}

/** The dev server's headers as the browser should read them: framable by Forge only, its own links. */
function downstreamHeaders(headers: IncomingHttpHeaders, port: number, origin: string) {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && name !== 'connection' && name !== 'keep-alive') out[name] = value;
  }
  const local = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${port}`);
  if (typeof out.location === 'string') out.location = out.location.replace(local, origin);
  const frame = `frame-ancestors ${new URL(env.APP_BASE_URL).origin}`;
  const csp = out['content-security-policy'];
  out['content-security-policy'] = csp === undefined ? frame : [...[csp].flat(), frame];
  return out;
}

function streamFor(row: PreviewRow): { ok: true; stream: Duplex } | { ok: false; page: Page } {
  const opened = openTunnelStream(row.deviceId, row.id);
  return opened.ok ? opened : { ok: false, page: tunnelDownPage(opened.why) };
}

const failureCode = (err: unknown) =>
  err instanceof TunnelStreamError ? err.code : (err as Error).message;

/** One HTTP request to a preview host. */
export async function relayPreviewRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? '/', 'http://preview.invalid');
    const admitted = await admit(req, url);
    if (admitted.ok === 'enter') return await enter(req, res, url);
    if (!admitted.ok) return sendPage(res, admitted.page);
    const { row, site } = admitted;
    await noteViewed(row);
    const opened = streamFor(row);
    if (!opened.ok) return sendPage(res, opened.page);
    const origin = previewOrigin(site, row.slug);
    const port = row.port ?? 0;
    const upstream = httpRequest({
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, port, origin, false),
      createConnection: () => opened.stream as never,
    });
    upstream.on('response', (answer) => {
      res.writeHead(answer.statusCode ?? 502, downstreamHeaders(answer.headers, port, origin));
      answer.pipe(res);
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) sendPage(res, devServerErrorPage(failureCode(err)));
      else res.destroy();
    });
    res.on('close', () => opened.stream.destroy());
    req.pipe(upstream);
  } catch (err) {
    logger.error({ err }, 'preview relay: request failed');
    if (!res.headersSent) sendPage(res, devServerErrorPage('RELAY_ERROR'));
    else res.destroy();
  }
}

function refuseUpgrade(socket: Duplex, page: Page): void {
  socket.end(
    `HTTP/1.1 ${page.status} ${page.title}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
  );
}

function headLines(status: number, message: string, rawHeaders: readonly string[]): string {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** A WebSocket upgrade to a preview host: the dev server's hot reload, carried on its own stream. */
export async function relayPreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  try {
    const url = new URL(req.url ?? '/', 'http://preview.invalid');
    const admitted = await admit(req, url);
    if (admitted.ok === 'enter') return refuseUpgrade(socket, notFoundPage());
    if (!admitted.ok) return refuseUpgrade(socket, admitted.page);
    const { row, site } = admitted;
    await noteViewed(row);
    const opened = streamFor(row);
    if (!opened.ok) return refuseUpgrade(socket, opened.page);
    const origin = previewOrigin(site, row.slug);
    const upstream = httpRequest({
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, row.port ?? 0, origin, true),
      createConnection: () => opened.stream as never,
    });
    upstream.on('upgrade', (answer, tunnelSocket, upstreamHead) => {
      socket.write(
        headLines(101, answer.statusMessage ?? 'Switching Protocols', answer.rawHeaders),
      );
      if (upstreamHead.byteLength > 0) socket.write(upstreamHead);
      if (head.byteLength > 0) tunnelSocket.write(head);
      tunnelSocket.pipe(socket);
      socket.pipe(tunnelSocket);
      const end = () => {
        tunnelSocket.destroy();
        socket.destroy();
      };
      tunnelSocket.on('error', end);
      socket.on('error', end);
      tunnelSocket.on('close', end);
      socket.on('close', end);
    });
    upstream.on('response', (answer) => {
      socket.write(
        headLines(answer.statusCode ?? 502, answer.statusMessage ?? '', answer.rawHeaders),
      );
      answer.pipe(socket);
    });
    upstream.on('error', (err) => refuseUpgrade(socket, devServerErrorPage(failureCode(err))));
    upstream.end();
  } catch (err) {
    logger.error({ err }, 'preview relay: upgrade failed');
    socket.destroy();
  }
}
