// A Forge Box world for integration tests (ISS-1276, ISS-1321, ISS-1324): a project bound to one
// device, an issue, and three callers (an agent's token, a person's session, the device's
// credential). The device's frames are read off the outbox, as the runner reads them off its socket.

import type { BoxHealthReport } from '@forge/contracts/box-wire';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { db } from '../../src/db/client.js';
import { userToken } from './api.js';
import { type Doc, type Reply, requester, startQueue, testEnv } from './ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from './factories.js';

export type Say = (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;

/** A device with room for every served mode: browser and android serve, desktop and ios do not. */
export const healthy = (
  over: Partial<BoxHealthReport> = {},
  held: string[] = [],
): BoxHealthReport => ({
  memory: { availableMb: 64 * 1024, reserveMb: 16 * 1024 },
  cpu: { pressureSomeAvg10: 4, ceiling: 40 },
  disk: { freeMb: 400 * 1024, reserveMb: 20 * 1024 },
  kvm: true,
  modes: [
    {
      mode: 'browser',
      serves: true,
      lacks: [],
      fix: null,
      cost: { memoryMb: 600, diskMb: 100, cpuCores: 1 },
      versions: { 'agent-browser': '0.43.0' },
    },
    {
      mode: 'android',
      serves: true,
      lacks: [],
      fix: null,
      cost: { memoryMb: 4096, diskMb: 512, cpuCores: 3 },
      versions: { emulator: '37.2' },
    },
    {
      mode: 'desktop',
      serves: false,
      lacks: ['agent-desktop'],
      fix: '`forge-runner setup`',
      cost: { memoryMb: 800, diskMb: 100, cpuCores: 1 },
      versions: {},
    },
  ],
  held,
  ...over,
});

/** The frames the device was sent for a box, oldest first. */
export async function boxFrames(
  boxId: string,
  event?: string,
): Promise<Array<{ event: string; data: Doc }>> {
  const rows = (await db.execute(sql`
    SELECT payload FROM pipeline_outbox
     WHERE type = 'device.pushed' AND payload -> 'data' ->> 'boxId' = ${boxId}
     ORDER BY seq`)) as unknown as Array<{ payload: { event: string; data: Doc } }>;
  return [...rows].map((r) => r.payload).filter((p) => !event || p.event === event);
}

export interface BoxWorld {
  app: Hono;
  say: Say;
  deviceToken: string;
  projectId: string;
  issueId: string;
  deviceId: string;
  /** A heartbeat carrying `box` health, accepted. */
  beat: (box: BoxHealthReport) => Promise<void>;
  box: (id: string) => Promise<Doc>;
}

export async function boxWorld(): Promise<BoxWorld> {
  testEnv();
  const app = (await import('../../src/index.js')).app as unknown as Hono;
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${projectId}, 1, 'Redeem points at the counter', 'in_progress', 'high', ${ownerId})
    RETURNING id`)) as unknown as Array<{ id: string }>;
  const mint = async (name: string, device?: string) =>
    (
      await mintPat({
        permissions: ['*'],
        userId: ownerId,
        name,
        projectIds: [projectId],
        grantEpoch: 99,
        ...(device ? { deviceId: device } : {}),
      })
    ).plaintext;
  const deviceToken = await mint('device', deviceId);
  const say = requester(app as never, {
    agent: await mint('agent'),
    device: deviceToken,
    person: await userToken(ownerId),
  }) as Say;
  return {
    app,
    say,
    deviceToken,
    projectId,
    issueId: (row as { id: string }).id,
    deviceId,
    beat: async (box) => {
      const r = await say('device', 'POST', '/api/devices/heartbeat', { box });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    },
    box: async (id) => (await say('agent', 'GET', `/api/boxes/${id}`)).json.box as Doc,
  };
}
