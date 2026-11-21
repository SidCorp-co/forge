import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { completeAct } from '../../src/boxes/acts.js';
import { agentAct, openBox } from '../../src/boxes/index.js';
import { reportBox } from '../../src/boxes/report.js';
import type { BoxRow } from '../../src/db/schema-boxes.js';
import { deviceRoom, roomManager } from '../../src/lib/rooms.js';
import { api } from '../helpers/api.js';
import { createTestProject, rows } from '../helpers/factories.js';
import { healthy } from '../helpers/forge-box-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/room-grant.ts
// @direct-test-of packages/core/src/support/look-act.ts
// @direct-test-of packages/core/src/boxes/service.ts
// @direct-test-of packages/core/src/boxes/acts.ts
// @direct-test-of packages/core/src/permissions/can.ts
// @direct-test-of packages/core/src/lib/authz.ts
//
// ISS-1394: a room's look acts as the room's agent account, which is a member of nothing, and the
// box's open and act asked `project.write`, so every look was refused before a box opened. The
// account now holds `boxes.drive` on its room's project alone, by the room that minted it: the real
// openBox, agentAct and closeBox run as it, and it still holds no role, so it reads and writes
// nothing else and drives no box of another project.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const ENV_URL = 'https://stg.desk.example.test';

const w = new SupportWorld();
let chat: StandInRocketChat;
let deviceId = '';

/** The session's device as forge-runner is: a box it is told to open comes up, an act is run. */
const device = {
  readyState: 1,
  send(payload: string) {
    const { event, data } = JSON.parse(payload) as {
      event: string;
      data: { boxId: string; actId?: string; command?: string[] };
    };
    if (event === 'box.open') {
      setImmediate(() =>
        reportBox(deviceId, data.boxId, {
          kind: 'state',
          state: 'ready',
          offer: { codec: 'jpeg-frames', width: 1280, height: 800 },
        }).catch(() => undefined),
      );
    }
    if (event === 'box.act' && data.actId) {
      const [verb] = data.command ?? [];
      const stdout =
        verb === 'get' ? `${ENV_URL}/orders` : verb === 'snapshot' ? '- heading "Orders"' : '';
      setImmediate(() =>
        completeAct({ id: data.boxId } as BoxRow, {
          actId: data.actId as string,
          exitCode: 0,
          stdout,
          stderr: '',
          durationMs: 2,
        }).catch(() => undefined),
      );
    }
  },
};

type Acts = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A member asks `ask`; the session runs `turn` on its thread. Answers what `turn` returned. */
async function inTurn<T>(ask: string, turn: (act: Acts, thread: string) => Promise<T>): Promise<T> {
  await w.settleWarm();
  let out: { value: T } | null = null;
  w.box.model = async (t, act) => {
    const m = t.messages.find((x) => x.from !== 'forge' && x.text === ask);
    if (!m) return;
    out = { value: await turn(act, m.thread) };
  };
  await chat.say(chat.bob, ask);
  await expect.poll(() => out, { timeout: 30_000 }).not.toBeNull();
  await w.settleWarm();
  w.box.model = async () => {};
  return (out as unknown as { value: T }).value;
}

/** The room's agent account: the one a look acts as. */
async function roomAccount(): Promise<string> {
  const [room] = await rows<{ principal_user_id: string }>(
    sql`SELECT principal_user_id FROM support_rooms WHERE project_id = ${w.projectId}::uuid`,
  );
  return room?.principal_user_id as string;
}

beforeAll(async () => {
  await w.start();
  await seedProjectDocument(w.projectId, w.ownerId, {
    environments: {
      staging: {
        tier: 'staging',
        deploysFrom: 'main',
        deployment: { mode: 'external' },
        url: ENV_URL,
      },
    },
    extra: { contentLanguage: 'en' },
  });
  await w.bind();
  chat = w.chat as StandInRocketChat;
  deviceId = w.box.deviceId;
  await rows(sql`UPDATE devices SET box_health = ${JSON.stringify(healthy())}::jsonb,
                 box_health_at = now() WHERE id = ${deviceId}::uuid`);
  roomManager.subscribe(device as never, deviceRoom(deviceId));
}, 120_000);

afterAll(async () => {
  roomManager.removeAll(device as never);
  await w.stop();
});

describe("a room's look drives a box as the room's own account (ISS-1394)", () => {
  it('opens, reads and closes a box on its own project, as an account that is no member', async () => {
    const look = await inTurn('Is the orders page up?', async (act, thread) => {
      const seen = await act({ action: 'look', thread, environment: 'staging', close: true });
      await act({ action: 'silent', thread, reason: 'test' });
      return seen;
    });
    expect(look, JSON.stringify(look)).toMatchObject({
      state: 'agent',
      url: `${ENV_URL}/orders`,
      closed: true,
    });
    expect(String(look.snapshot)).toContain('Orders');
    const account = await roomAccount();
    const [box] = await rows<{ created_by: string; state: string }>(
      sql`SELECT created_by, state FROM boxes WHERE id = ${look.box as string}::uuid`,
    );
    expect(box).toEqual({ created_by: account, state: 'closed' });
    // it drove the box holding no membership: its grant is its room's, not a role
    expect(await rows(sql`SELECT 1 FROM project_members WHERE user_id = ${account}::uuid`)).toEqual(
      [],
    );
  });

  it('opens no box on another project, and acts on no box of one', async () => {
    const account = await roomAccount();
    const actor = { userId: account, agency: 'agent' as const };
    const other = (await createTestProject(w.ownerId, { name: 'Another desk' })).id;
    await expect(
      openBox(actor, other, {
        mode: 'browser',
        url: ENV_URL,
        viewport: { width: 800, height: 600 },
      }),
    ).rejects.toThrow(/not a member of this project: open a box needs boxes\.drive/);
    const [theirs] = await rows<{ id: string }>(sql`
      INSERT INTO boxes (device_id, project_id, mode, state, created_by, opened_at, ready_at)
      VALUES (${deviceId}::uuid, ${other}::uuid, 'browser', 'agent', ${w.ownerId}::uuid, now(), now())
      RETURNING id`);
    await expect(agentAct(actor, theirs?.id as string, ['snapshot'])).rejects.toThrow(
      /not a member of this project: act on a box needs boxes\.drive/,
    );
  });

  it('writes no issue, config or variable and reads nothing with it', async () => {
    const account = await roomAccount();
    const { mintPat } = await import('../../src/credentials/pat.js');
    const token = (
      await mintPat({
        permissions: ['*'],
        userId: account,
        name: 'room-account-probe',
        projectIds: [w.projectId],
        grantEpoch: 99,
      })
    ).plaintext;
    const p = `/api/projects/${w.projectId}`;
    const said = [
      await api(token, 'POST', `${p}/issues`, { title: 'Written by a room', priority: 'low' }),
      await api(token, 'PUT', `${p}/config`, { baseRevision: null, document: {} }),
      await api(token, 'POST', `${p}/variables`, {
        key: 'PLANTED_KEY',
        value: 'planted-value',
        environment: null,
        type: 'plain',
        protected: false,
      }),
      await api(token, 'GET', `${p}/issues`),
    ];
    for (const res of said) expect(res.status, JSON.stringify(res.body)).toBe(403);
    // the box doors still declare project.write: the look's own guards are the only way in
    const door = await api(token, 'POST', `${p}/boxes`, { mode: 'browser', url: ENV_URL });
    expect(door.status, JSON.stringify(door.body)).toBe(403);
  });
});
