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
import { RECORDER_PATHS, RECORDING_LIMITS } from '@forge/contracts/reproduce';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { previewRecordings } from '../db/schema-preview-recordings.js';
import type { PreviewRow } from '../db/schema-previews.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { RefusalError, refusalEnvelope } from '../lib/refusal.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import {
  isHostUnderSite,
  labelOfHost,
  type PreviewSite,
  previewOrigin,
  previewSite,
} from './domain.js';
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
  tunnelRefusedPage,
} from './pages.js';
import { previewBySlug } from './read.js';
import {
  decoded,
  recorderScript,
  snapshotScript,
  takesSnapshots,
  withRecorderTag,
} from './recorder.js';
import { ingestBatch, recordingFor, records } from './recordings.js';
import { serves } from './rules.js';
import { noteViewed, reopenForViewer } from './service.js';
import { readViewer, signViewer, spendTicket } from './ticket.js';
import { openTunnelStream, streamEndOf } from './tunnel.js';

/** Whether a request names a preview host: it is answered here, never by the API. */
export function isPreviewRequest(req: IncomingMessage): boolean {
  return isHostUnderSite(req.headers.host, previewSite());
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

/** A request for the recorder's own paths, from a member holding this preview's viewer cookie. */
type RecorderAdmission = { ok: 'recorder'; row: PreviewRow; userId: string };

const RECORDER = new Set<string>([RECORDER_PATHS.script, RECORDER_PATHS.ingest]);

/** Who the request is and whether the preview serves them now; a page in Forge's words if not. */
async function admit(
  req: IncomingMessage,
  url: URL,
): Promise<Admission | RecorderAdmission | { ok: 'enter' }> {
  const site = previewSite();
  const label = labelOfHost(req.headers.host, site);
  if (site === null || label === null) return { ok: false, page: notFoundPage() };
  const row = await previewBySlug(label);
  if (!row) return { ok: false, page: notFoundPage() };
  if (url.pathname === PREVIEW_ENTER_PATH) return { ok: 'enter' };
  const recorder = RECORDER.has(url.pathname);
  if (url.pathname.startsWith(PREVIEW_RESERVED_PATH) && !recorder)
    return { ok: false, page: notFoundPage() };
  const token = cookiesOf(req.headers.cookie).viewer;
  const grant = token === null ? null : await readViewer(token);
  if (!grant || grant.previewId !== row.id) return { ok: false, page: signInPage() };
  if (!(await stillMember(grant.userId, row.projectId)))
    return { ok: false, page: notMemberPage() };
  // the recorder's paths answer a member of a recording preview only, whatever its state: a batch
  // after the preview closed is refused by the recording, by name
  if (recorder) {
    // an idea's page carries only the script that answers Forge's snapshot ask: it records nothing
    const taken = records(row) || (takesSnapshots(row) && url.pathname === RECORDER_PATHS.script);
    return taken
      ? { ok: 'recorder', row, userId: grant.userId }
      : { ok: false, page: notFoundPage() };
  }
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

/**
 * A stream to the preview's dev server, waiting its turn when it holds as many as it may. `gone`
 * aborts when the browser leaves first, so a request nobody waits for never takes one.
 */
async function streamFor(
  row: PreviewRow,
  gone: AbortSignal,
): Promise<{ ok: true; stream: Duplex } | { ok: false; page: Page }> {
  const opened = await openTunnelStream(row.deviceId, row.id, gone);
  return opened.ok ? opened : { ok: false, page: tunnelRefusedPage(opened.why) };
}

const failureCode = (err: unknown) => streamEndOf(err) ?? (err as Error).message;

function sendJson(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** A request body, up to `limit` bytes; one byte more says it is over. */
function bodyOf(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.byteLength;
      if (size <= limit + 1) chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).subarray(0, limit + 1)));
    req.on('error', reject);
  });
}

/** The recorder's script, and the batches it posts (BC-18): answered by core, never by the dev server. */
async function serveRecorder(req: IncomingMessage, res: ServerResponse, at: RecorderAdmission) {
  const url = new URL(req.url ?? '/', 'http://preview.invalid');
  if (url.pathname === RECORDER_PATHS.script) {
    const script = records(at.row)
      ? recorderScript((await recordingFor(at.row, at.userId)).id)
      : snapshotScript(new URL(env.APP_BASE_URL).origin);
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': Buffer.byteLength(script),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(script);
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-length': 0 });
    res.end();
    return;
  }
  try {
    const raw = await bodyOf(req, RECORDING_LIMITS.batchBytes);
    sendJson(res, 202, await ingestBatch(at.row, at.userId, raw));
  } catch (err) {
    if (!(err instanceof RefusalError)) throw err;
    const envelope = refusalEnvelope(err.refusals, err.fallbackCode);
    let owes: number | undefined;
    if (envelope.code === 'RECORDING_SEQ_GAP') {
      const id = (await recordingFor(at.row, at.userId)).id;
      const [held] = await db
        .select({ nextSeq: previewRecordings.nextSeq })
        .from(previewRecordings)
        .where(eq(previewRecordings.id, id));
      owes = held?.nextSeq;
    }
    sendJson(res, envelope.status, { ...envelope, ...(owes === undefined ? {} : { owes }) });
  }
}

/**
 * The dev server's HTML with the recorder's tag after `<head>` (BC-18): buffered whole, decoded
 * where the server compressed it anyway, and sent with its own length. Every other answer streams.
 */
function injectRecorder(
  answer: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string | string[]>,
  status: number,
): void {
  const chunks: Buffer[] = [];
  answer.on('data', (c: Buffer) => chunks.push(c));
  answer.on('error', () => res.destroy());
  answer.on('end', () => {
    const encoding = answer.headers['content-encoding'];
    const html = withRecorderTag(decoded(Buffer.concat(chunks), encoding).toString('utf8'));
    const out = { ...headers };
    delete out['content-encoding'];
    delete out['transfer-encoding'];
    out['content-length'] = String(Buffer.byteLength(html));
    res.writeHead(status, out);
    res.end(html);
  });
}

const isHtml = (headers: IncomingHttpHeaders) =>
  /^text\/html\b/i.test(String(headers['content-type'] ?? ''));

/** One HTTP request to a preview host. */
export async function relayPreviewRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? '/', 'http://preview.invalid');
    const admitted = await admit(req, url);
    if (admitted.ok === 'enter') return await enter(req, res, url);
    if (admitted.ok === 'recorder') return await serveRecorder(req, res, admitted);
    if (!admitted.ok) return sendPage(res, admitted.page, req);
    const { row, site } = admitted;
    await noteViewed(row);
    const left = new AbortController();
    res.on('close', () => left.abort());
    const opened = await streamFor(row, left.signal);
    if (!opened.ok) return left.signal.aborted ? undefined : sendPage(res, opened.page, req);
    // the browser went while this waited for its stream: give the stream back at once
    res.on('close', () => opened.stream.destroy());
    if (res.destroyed) return opened.stream.destroy();
    const origin = previewOrigin(site, row.slug);
    const port = row.port ?? 0;
    const recording = records(row);
    const injecting = recording || takesSnapshots(row);
    const headers = upstreamHeaders(req, port, origin, false);
    // a recording or idea preview's HTML is rewritten, so it is asked for unencoded (BC-18, BC-16)
    if (injecting) headers['accept-encoding'] = 'identity';
    const upstream = httpRequest({
      method: req.method,
      path: req.url,
      headers,
      createConnection: () => opened.stream as never,
    });
    upstream.on('response', (answer) => {
      const status = answer.statusCode ?? 502;
      const out = downstreamHeaders(answer.headers, port, origin);
      if (injecting && isHtml(answer.headers)) {
        delete out['content-length'];
        if (!recording) {
          injectRecorder(answer, res, out, status);
          return;
        }
        void recordingFor(row, admitted.userId).then(
          () => injectRecorder(answer, res, out, status),
          (err: unknown) => {
            logger.error({ err, previewId: row.id }, 'preview relay: the recording could not open');
            injectRecorder(answer, res, out, status);
          },
        );
        return;
      }
      res.writeHead(status, out);
      answer.pipe(res);
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) sendPage(res, devServerErrorPage(failureCode(err)), req);
      else res.destroy();
    });
    req.pipe(upstream);
  } catch (err) {
    logger.error({ err }, 'preview relay: request failed');
    if (!res.headersSent) sendPage(res, devServerErrorPage('RELAY_ERROR'));
    else res.destroy();
  }
}

function refuseUpgrade(socket: Duplex, page: Page): void {
  const body = `${page.title}. ${page.body.replace(/\n/g, ' ')}`;
  const retry = page.status === 503 ? (page.retryAfter ?? page.refresh) : undefined;
  socket.end(
    `HTTP/1.1 ${page.status} ${page.title.replace(/[^\x20-\x7e]/g, '')}\r\n` +
      `connection: close\r\nx-forge-preview-refusal: ${page.code}\r\n` +
      (retry === undefined ? '' : `retry-after: ${retry}\r\n`) +
      `content-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
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
    if (admitted.ok === 'enter' || admitted.ok === 'recorder')
      return refuseUpgrade(socket, notFoundPage());
    if (!admitted.ok) return refuseUpgrade(socket, admitted.page);
    const { row, site } = admitted;
    await noteViewed(row);
    // a server socket is half-open (`allowHalfOpen`): a browser that goes away sends its FIN and the
    // socket stays, so the end of its side is what says it left, not only `close`
    const left = new AbortController();
    for (const gone of ['close', 'end', 'error'] as const) socket.on(gone, () => left.abort());
    // a socket nobody reads never reports the FIN; a browser sends nothing before the 101
    socket.resume();
    const opened = await streamFor(row, left.signal);
    if (!opened.ok) return left.signal.aborted ? undefined : refuseUpgrade(socket, opened.page);
    // every way this ends, the browser leaving first included, gives the stream back
    for (const gone of ['close', 'end', 'error'] as const)
      socket.on(gone, () => opened.stream.destroy());
    if (left.signal.aborted) return opened.stream.destroy();
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
