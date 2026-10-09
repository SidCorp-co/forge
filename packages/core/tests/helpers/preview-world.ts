// A world for the live preview (REQ-39): core served over a real socket with the preview hosts
// dispatched as the entry dispatches them, a dev server on loopback with a hot-reload socket, and a
// stand-in box that speaks the control frames, the reports and the tunnel as the runner does.

import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect, type Socket } from 'node:net';
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_LIMITS,
  type TunnelFrame,
} from '@forge/contracts/preview-tunnel';
import { getRequestListener } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { app } from '../../src/index.js';
import { withPreviewHosts } from '../../src/previews/index.js';
import { attachWs, closeWs } from '../../src/ws/server.js';
import { api, userToken } from './api.js';
import { closeWorld, settleOutbox, startQueue } from './ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
} from './factories.js';
import { seedProjectDocument } from './release-world.js';

export interface Served {
  server: Server;
  base: string;
  port: number;
}

/** Core as its entry serves it: preview hosts first, then the API, and the WebSocket door. */
export async function serveCore(): Promise<Served> {
  const server = createHttpServer(withPreviewHosts(getRequestListener(app.fetch)));
  attachWs(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, port };
}

export async function stopCore(s: Served): Promise<void> {
  await closeWs();
  s.server.closeAllConnections();
  await new Promise<void>((r) => s.server.close(() => r()));
}

export interface DevServer {
  port: number;
  /** Every request the dev server saw, with the headers it was sent. */
  seen: { url: string; headers: Record<string, string | string[] | undefined> }[];
  close(): Promise<void>;
}

/** A dev server on loopback: `/` answers HTML and a project cookie, `/hmr` is its hot-reload socket. */
export async function devServer(): Promise<DevServer> {
  const seen: DevServer['seen'] = [];
  const server = createHttpServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${port}/landed` });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': 'app_session=from-the-project; Path=/',
      'content-security-policy': "default-src 'self'",
    });
    res.end('<!doctype html><title>dev</title><h1>the change being made</h1>');
  });
  const hmr = new WebSocketServer({ server, path: '/hmr' });
  hmr.on('connection', (ws) => ws.on('message', (m) => ws.send(`update:${String(m)}`)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    seen,
    close: async () => {
      hmr.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

interface Received {
  event: string;
  data: Record<string, unknown>;
}

/**
 * The runner's part, as `runner-preview` plays it: it hears the control frames on `/ws`, opens the
 * tunnel when asked to start, reports to core over REST, and pipes each stream to the dev server.
 */
export class StandInBox {
  readonly heard: Received[] = [];
  control: WebSocket | null = null;
  tunnel: WebSocket | null = null;
  private readonly streams = new Map<number, { sock: Socket; credit: number; got: number }>();
  /** What the box reports when asked to start; replaced by a test to plant a failure. */
  onStart: (frame: Record<string, unknown>) => Record<string, unknown> | null = () => null;
  devPort = 0;

  constructor(
    readonly base: string,
    readonly token: string,
    readonly deviceId: string,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'subscribe', room: `device:${this.deviceId}` }));
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as Received;
      this.heard.push(frame);
      void this.on(frame);
    });
    this.control = ws;
    await new Promise((r) => setTimeout(r, 100));
  }

  async report(previewId: string, body: Record<string, unknown>) {
    const res = await fetch(`${this.base}/api/previews/${previewId}/report`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  private async on(frame: Received): Promise<void> {
    if (frame.event === 'preview.start') {
      await this.openTunnel();
      const answer = this.onStart(frame.data);
      if (answer) await this.report(String(frame.data.previewId), answer);
    }
  }

  async openTunnel(): Promise<void> {
    if (this.tunnel && this.tunnel.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws/preview-tunnel`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.on('message', (raw: Buffer) => this.onTunnel(new Uint8Array(raw)));
    this.tunnel = ws;
  }

  private send(frame: TunnelFrame): void {
    this.tunnel?.send(encodeTunnelFrame(frame));
  }

  private onTunnel(message: Uint8Array): void {
    const decoded = decodeTunnelFrame(message);
    if (!decoded.ok) throw new Error(`core sent a bad frame: ${decoded.detail}`);
    const f = decoded.frame;
    const held = this.streams.get(f.streamId);
    if (f.type === 'open') {
      const sock = connect(this.devPort, '127.0.0.1');
      const entry = { sock, credit: TUNNEL_LIMITS.initialWindow, got: 0 };
      this.streams.set(f.streamId, entry);
      sock.on('data', (chunk: Buffer) => {
        for (let at = 0; at < chunk.byteLength; at += TUNNEL_LIMITS.maxDataBytes) {
          const bytes = chunk.subarray(at, at + TUNNEL_LIMITS.maxDataBytes);
          entry.credit -= bytes.byteLength;
          this.send({ type: 'data', streamId: f.streamId, bytes });
        }
        if (entry.credit <= 0) sock.pause();
      });
      sock.on('end', () => this.send({ type: 'close', streamId: f.streamId }));
      sock.on('error', () =>
        this.send({ type: 'reset', streamId: f.streamId, code: 'CONNECT_REFUSED' }),
      );
      return;
    }
    if (!held) return;
    if (f.type === 'data') {
      held.sock.write(f.bytes);
      held.got += f.bytes.byteLength;
      if (held.got >= TUNNEL_LIMITS.windowUpdateAt) {
        this.send({ type: 'window', streamId: f.streamId, delta: held.got });
        held.got = 0;
      }
    } else if (f.type === 'window') {
      held.credit += f.delta;
      if (held.credit > 0) held.sock.resume();
    } else if (f.type === 'close') {
      held.sock.end();
    } else if (f.type === 'reset') {
      held.sock.destroy();
      this.streams.delete(f.streamId);
    }
  }

  heardOf(event: string): Received[] {
    return this.heard.filter((f) => f.event === event);
  }

  async until(event: string, count = 1, ms = 15_000): Promise<Received> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const all = this.heardOf(event);
      const nth = all[count - 1];
      if (nth) return nth;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `the box heard ${this.heardOf(event).length} ${event} within ${ms}ms, wanted ${count}`,
    );
  }

  close(): void {
    this.tunnel?.close();
    this.control?.close();
    for (const s of this.streams.values()) s.sock.destroy();
  }
}

/** A credential for a box, as pairing mints one. */
export async function boxToken(ownerId: string, deviceId: string): Promise<string> {
  return (
    await mintPat({
      userId: ownerId,
      name: deviceTokenNameFor(deviceId),
      permissions: ['*'],
      deviceId,
    })
  ).plaintext;
}

/**
 * A run session working issue `ISS-<seq>` on `deviceId`, holding a worktree its box reports: the
 * lease binds it to the issue, the ledger row says the checkout is on disk.
 */
export async function liveRun(
  projectId: string,
  deviceId: string,
  seq: number,
): Promise<{ sessionId: string; runId: string }> {
  const runId = await createTestRunSession(projectId, deviceId, new Date(), null);
  const [session] = (await db.execute(
    sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
  )) as unknown as { id: string }[];
  if (!session) throw new Error('the run session was not written');
  await db.execute(sql`
    INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
    VALUES (${projectId}, ${`ISS-${seq}`}, ${deviceId}, ${session.id}, ${runId})
  `);
  await db.execute(sql`
    INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id, incarnation, work, issues)
    VALUES (${deviceId}, ${randomUUID()}, ${projectId}, ${session.id}, ${`/srv/worktrees/iss-${seq}`}, 'boot', 'live', 'working',
            ${JSON.stringify([{ issueKey: `ISS-${seq}`, leaseReturned: false }])}::jsonb)
  `);
  return { sessionId: session.id, runId };
}

/** A request to a preview host, as a browser at `<label>.<PREVIEW_DOMAIN>` sends it. */
export function atPreview(
  core: Served,
  previewUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  const host = new URL(previewUrl).host;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: core.port, path, headers: { host, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A Vite app's package.json, as the box reports it when the project names no setting. */
export const VITE_PACKAGE = JSON.stringify({
  name: 'shop',
  scripts: { dev: 'vite' },
  devDependencies: { vite: '^6.0.0' },
});

/** The project's environments: one dev, which a preview talks to, and production, which it never does. */
export const PREVIEW_ENVIRONMENTS = {
  dev: {
    tier: 'dev' as const,
    deployment: { mode: 'external' as const },
    url: 'https://dev.shop.example.test',
    services: { api: 'https://api.dev.shop.example.test' },
  },
  live: { tier: 'production' as const, deployment: { mode: 'external' as const } },
};

/** The `name=value` of the first cookie a response sets. */
export const cookieOf = (setCookie: string | string[] | undefined) =>
  String([setCookie].flat()[0]).split(';')[0] as string;

/**
 * A project with an owner, a member and a stranger, core served over a real socket, a dev server,
 * and a stand-in box that reports the Vite app's facts and then takes the preview live.
 */
export class PreviewWorld {
  core!: Served;
  dev!: DevServer;
  box!: StandInBox;
  projectId = '';
  ownerId = '';
  memberId = '';
  owner = '';
  member = '';
  stranger = '';
  issueId = '';
  private seq = 0;

  async start(): Promise<void> {
    await startQueue();
    const o = await createTestUser({ verified: true });
    const m = await createTestUser({ verified: true });
    const s = await createTestUser({ verified: true });
    this.ownerId = o.id;
    this.memberId = m.id;
    this.projectId = (await createTestProject(o.id)).id;
    await addProjectMember(this.projectId, o.id, 'owner');
    await addProjectMember(this.projectId, m.id, 'member');
    this.owner = await userToken(o.id);
    this.member = await userToken(m.id);
    this.stranger = await userToken(s.id);
    await seedProjectDocument(this.projectId, o.id, { environments: PREVIEW_ENVIRONMENTS });
    this.core = await serveCore();
    this.dev = await devServer();
    const deviceId = await createTestDevice(o.id);
    this.box = new StandInBox(this.core.base, await boxToken(o.id, deviceId), deviceId);
    this.box.devPort = this.dev.port;
    this.serveVite();
    await this.box.connect();
    this.issueId = await this.issueWithRun();
  }

  /** The box as it answers a Vite app: its facts while unset, then live on the dev server. */
  serveVite(): void {
    const devPort = this.dev.port;
    this.box.onStart = (frame) =>
      frame.settings === null
        ? {
            kind: 'facts',
            facts: { cwd: '', packageJson: VITE_PACKAGE, lockfiles: ['package-lock.json'] },
          }
        : { kind: 'live', port: devPort };
  }

  async stop(): Promise<void> {
    this.box?.close();
    await this.dev?.close();
    if (this.core) await stopCore(this.core);
    await closeWorld();
  }

  /** A new issue with its own live run on the box. */
  async issueWithRun(): Promise<string> {
    this.seq += 1;
    const issue = await createTestIssue(this.projectId, this.ownerId, this.seq, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    await liveRun(this.projectId, this.box.deviceId, this.seq);
    return issue.id;
  }

  /** A new open issue no run works. */
  async issueWithoutRun(): Promise<string> {
    this.seq += 1;
    const issue = await createTestIssue(this.projectId, this.ownerId, this.seq, {
      status: 'open',
      createdAt: new Date(),
    });
    return issue.id;
  }

  /** Open a preview and let the box take it live; answers the record. */
  async livePreview(id: string): Promise<{ id: string; url: string }> {
    const opened = await api(this.owner, 'POST', `/api/issues/${id}/preview`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const preview = opened.body.preview as { id: string; url: string };
    await settleOutbox();
    await expect
      .poll(
        async () => (await api(this.owner, 'GET', `/api/previews/${preview.id}`)).body.preview,
        { timeout: 15_000, interval: 100 },
      )
      .toMatchObject({ state: 'live' });
    return preview;
  }

  /** A viewer's cookie on the preview host, by spending a ticket as the browser does. */
  async enter(preview: { id: string; url: string }, token = this.owner) {
    const ticket = await api(token, 'POST', `/api/previews/${preview.id}/ticket`);
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
    const url = new URL(String(ticket.body.url));
    const entered = await atPreview(this.core, preview.url, `${url.pathname}${url.search}`);
    return { entered, path: `${url.pathname}${url.search}` };
  }
}
