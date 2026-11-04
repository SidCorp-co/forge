/**
 * ISS-951: the `org:<id>` room opens to a member of the org and to no one else, a box included, and
 * a step a written plan moves reaches it through the outbox as `org.activity.changed`, so the
 * workspace's Activity page reads again without polling.
 *
 * @direct-test-of packages/core/src/ws/server.ts
 * @direct-test-of packages/core/src/ws/broadcast-subscribers.ts
 * @direct-test-of packages/core/src/lib/rooms.ts
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { orgRoom } from '../../src/lib/rooms.js';
import { attachWs, closeWs } from '../../src/ws/server.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

let server: Server;
let url = '';
let orgId = '';
let projectId = '';
let ownerToken = '';
let strangerToken = '';
let boxToken = '';
let ownerId = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const owner = await createTestUser({ verified: true });
  ownerId = owner.id;
  const stranger = await createTestUser({ verified: true });
  const project = await createTestProject(owner.id);
  projectId = project.id;
  orgId = project.orgId;
  await addProjectMember(projectId, owner.id, 'owner');
  ownerToken = await userToken(owner.id);
  strangerToken = await userToken(stranger.id);
  const deviceId = await createTestDevice(owner.id);
  boxToken = (
    await mintPat({
      userId: owner.id,
      name: deviceTokenNameFor(deviceId),
      permissions: ['*'],
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  server = createServer();
  attachWs(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
}, 120_000);

afterAll(async () => {
  await closeWs();
  await new Promise<void>((r) => server.close(() => r()));
  await closeWorld();
});

/** Opens a socket, subscribes to the org room, and keeps every frame it hears. */
async function listen(bearer: string): Promise<{ ws: WebSocket; frames: Frame[]; answer: string }> {
  const ws = new WebSocket(url, [`forge.bearer.${bearer}`]);
  const frames: Frame[] = [];
  const answer = await new Promise<string>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', room: orgRoom(orgId), replayMs: 0 })));
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      frames.push(frame);
      if (frame.event === 'replay.done' || frame.event === 'subscribe.denied') resolve(frame.event);
    });
    setTimeout(() => resolve('no answer'), 5_000);
  });
  return { ws, frames, answer };
}

describe('ISS-951 the org room', () => {
  it('opens to a member of the org', async () => {
    const { ws, answer } = await listen(ownerToken);
    ws.close();
    expect(answer).toBe('replay.done');
  });

  it('is refused to a person outside the org', async () => {
    const { ws, answer } = await listen(strangerToken);
    ws.close();
    expect(answer).toBe('subscribe.denied');
  });

  it('is refused to a box, whose token reaches projects and never a workspace', async () => {
    const { ws, answer } = await listen(boxToken);
    ws.close();
    expect(answer).toBe('subscribe.denied');
  });

  it('hears a step a written plan moved, naming the project and the step', async () => {
    const { ws, frames, answer } = await listen(ownerToken);
    expect(answer).toBe('replay.done');
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, 1, 'claimed', 'in_progress', ${ownerId})`);
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at, updated_at)
      VALUES (${id}, 'triage', now() - interval '1 hour', now())`);
    const planned = await api(ownerToken, 'PATCH', `/api/issues/${id}`, { plan: 'the plan' });
    expect(planned.status).toBe(200);
    const heard = await new Promise<Frame | null>((resolve) => {
      const started = Date.now();
      const look = () => {
        const f = frames.find((x) => x.event === 'org.activity.changed' && x.data.source === 'step');
        if (f) resolve(f);
        else if (Date.now() - started > 25_000) resolve(null);
        else setTimeout(look, 200);
      };
      look();
    });
    ws.close();
    expect(heard?.data, 'the org room never heard the step move').toEqual({
      orgId,
      projectId,
      source: 'step',
    });
  }, 40_000);
});
