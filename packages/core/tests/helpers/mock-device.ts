import WebSocket from 'ws';
import type { TestServer } from './app-server.js';

/**
 * In-process stand-in for the Rust runner — opens a real ws connection, fetches
 * against the real REST surface, and streams JobEvents the way the agent does.
 * Used by the device-runner E2E (ISS-218).
 *
 * Pairs for real: a project member mints a code at
 * `POST /api/projects/:id/devices/pairing-codes`, the device redeems it at the
 * public `POST /api/devices/pair`.
 */
// cm:guard no fallback path, and no env flag to pick one. This helper had both, and the fallback minted a token through `issueDeviceToken` so the file compiled while the real branch was never executed — three bugs accumulated in it unseen (unscoped URL, no auth header, reading `token` where the route returns `deviceToken`) and the E2E advertised itself as ready to flip for months. A seam that is only exercised behind a flag nobody sets is not tested.
// cm:edge contract -> packages/core/src/devices/routes.ts — mints at deviceUserRoutes `/:id/devices/pairing-codes` (mounted under /api/projects, requires a verified project member) and redeems at devicePublicRoutes `/pair`, which answers `{ deviceId, deviceToken, projectId }`. Nothing type-checks these two shapes across the fetch boundary.

export interface MockDeviceEvent {
  event: string;
  data: unknown;
  at: number;
}

export interface MockDevice {
  id: string;
  token: string;
  connectWs(): Promise<void>;
  waitForAssign(timeoutMs: number): Promise<{ jobId: string; data: unknown; at: number }>;
  waitForFrame(pred: (ev: MockDeviceEvent) => boolean, timeoutMs: number): Promise<MockDeviceEvent>;
  postEvents(
    jobId: string,
    batch: Array<{ kind: string; data: Record<string, unknown> }>,
  ): Promise<Response>;
  complete(
    jobId: string,
    args: { exitCode: number; error?: string | null; summary?: string },
  ): Promise<Response>;
  close(): Promise<void>;
}

export interface PairMockDeviceOpts {
  server: TestServer;
  projectId: string;
  userJwt: string;
  name?: string;
  platform?: 'macos' | 'linux' | 'windows';
}

export async function pairMockDevice(opts: PairMockDeviceOpts): Promise<MockDevice> {
  const { server, projectId, userJwt } = opts;

  const codeRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/devices/pairing-codes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userJwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!codeRes.ok) {
    throw new Error(
      `pairMockDevice: POST /api/projects/${projectId}/devices/pairing-codes responded ${codeRes.status}`,
    );
  }
  const { code } = (await codeRes.json()) as { code: string };

  const pairRes = await fetch(`${server.baseUrl}/api/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      name: opts.name ?? 'mock-device',
      platform: opts.platform ?? 'linux',
    }),
  });
  if (!pairRes.ok) {
    throw new Error(`pairMockDevice: POST /api/devices/pair responded ${pairRes.status}`);
  }
  const paired = (await pairRes.json()) as { deviceId: string; deviceToken: string };
  const deviceId = paired.deviceId;
  const token = paired.deviceToken;

  const inbound: MockDeviceEvent[] = [];
  let ws: WebSocket | null = null;

  async function connectWs(): Promise<void> {
    ws = new WebSocket(server.wsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws?.once('open', () => resolve());
      ws?.once('error', reject);
    });
    ws.on('message', (buf) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const { event, data } = parsed as { event?: unknown; data?: unknown };
      if (typeof event !== 'string') return;
      inbound.push({ event, data, at: performance.now() });
    });
    // Subscribe to our own device room so we receive `job.assigned` frames.
    ws.send(JSON.stringify({ type: 'subscribe', room: `device:${deviceId}` }));
    // Small settle to let the server register the subscription before the
    // first broadcast. See Risks §"Observer race on subscribe" in the plan.
    await new Promise((r) => setTimeout(r, 20));
  }

  async function waitForFrame(
    pred: (ev: MockDeviceEvent) => boolean,
    timeoutMs: number,
  ): Promise<MockDeviceEvent> {
    const start = performance.now();
    // Poll the buffered queue; `ws.on('message')` is synchronous so any frame
    // that arrived while we were awaiting something else is already here.
    while (performance.now() - start < timeoutMs) {
      const hit = inbound.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `waitForFrame: timeout after ${timeoutMs}ms. Recorded events: ${JSON.stringify(
        inbound.map((e) => e.event),
      )}`,
    );
  }

  async function waitForAssign(timeoutMs: number) {
    const frame = await waitForFrame(
      (ev) => ev.event === 'job.assigned' || ev.event === 'job.dispatched',
      timeoutMs,
    );
    const data = frame.data as { jobId?: string };
    if (!data.jobId) {
      throw new Error(`waitForAssign: frame missing jobId — ${JSON.stringify(frame)}`);
    }
    return { jobId: data.jobId, data: frame.data, at: frame.at };
  }

  async function postEvents(
    jobId: string,
    batch: Array<{ kind: string; data: Record<string, unknown> }>,
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events: batch }),
    });
  }

  async function complete(
    jobId: string,
    args: { exitCode: number; error?: string | null; summary?: string },
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
  }

  async function close(): Promise<void> {
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000);
      await new Promise<void>((resolve) => {
        ws?.once('close', () => resolve());
      });
    }
    ws = null;
  }

  return {
    id: deviceId,
    token,
    connectWs,
    waitForAssign,
    waitForFrame,
    postEvents,
    complete,
    close,
  };
}
