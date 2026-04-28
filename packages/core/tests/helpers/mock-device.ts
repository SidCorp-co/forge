import { sql } from 'drizzle-orm';
import WebSocket from 'ws';
import type { TestServer } from './app-server.js';
import type { TestDb } from './db.js';

/**
 * In-process stand-in for `packages/dev` — opens a real ws connection, fetches
 * against the real REST surface, and streams JobEvents the same way the Rust
 * agent will. Used by the Phase 2.7-F2 device-runner E2E (ISS-218).
 *
 * Auth flow:
 * - **Preferred (once ISS-214 lands):** `POST /api/devices/pairing-codes` →
 *   `POST /api/devices/pair`. Gated behind `FORGE_E2E_REAL_PAIR=1`.
 * - **Fallback (today):** call `issueDeviceToken` directly — same seam used by
 *   `createTestDevice`, but producing a real argon2 hash so the token actually
 *   verifies through `requireDevice()`.
 */

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
  db: TestDb;
  ownerId: string;
  name?: string;
  platform?: 'macos' | 'linux' | 'windows';
}

export async function pairMockDevice(opts: PairMockDeviceOpts): Promise<MockDevice> {
  const { server, ownerId } = opts;

  // AuthN: preferred path (real pair endpoint) is gated on ISS-214 shipping.
  // Until then, fall back to the internal token factory. The test harness
  // flips mode via `FORGE_E2E_REAL_PAIR=1`.
  const useRealPair = process.env.FORGE_E2E_REAL_PAIR === '1';

  let deviceId: string;
  let token: string;

  if (useRealPair) {
    // This path intentionally has no fallback — if the endpoints are absent
    // the test fails loudly rather than silently falling back to the stub.
    const codeRes = await fetch(`${server.baseUrl}/api/devices/pairing-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!codeRes.ok) {
      throw new Error(
        `pairMockDevice(real): /api/devices/pairing-codes responded ${codeRes.status}`,
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
      throw new Error(`pairMockDevice(real): /api/devices/pair responded ${pairRes.status}`);
    }
    const paired = (await pairRes.json()) as { deviceId: string; token: string };
    deviceId = paired.deviceId;
    token = paired.token;
  } else {
    const { issueDeviceToken } = await import('../../src/auth/deviceToken.js');
    const issued = await issueDeviceToken({
      ownerId,
      name: opts.name ?? 'mock-device',
      platform: opts.platform ?? 'linux',
    });
    deviceId = issued.device.id;
    token = issued.plaintext;
  }

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

  // Touch opts.db so it's clearly part of the helper contract even though the
  // current fallback does not need a direct db handle. Once the real pair
  // endpoint lands, seeding/cleanup inspections can piggy-back here.
  void opts.db;
  void sql;

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
