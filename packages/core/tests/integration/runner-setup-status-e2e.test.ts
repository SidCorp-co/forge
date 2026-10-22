/**
 * A runner row's setup (provision) status is a kernel status (REQ-12 BC-17): it is born at its
 * machine's initial state, `queued`, whichever door makes the row, and only the kernel transition
 * moves it. A row born with no status could not be moved at all — no edge leaves NULL — so a box's
 * report and a re-bind each answered success while nothing changed. Migration 0515 gives every such
 * row the state it was always in and makes the column refuse NULL.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { bootstrapRunnerAdapters } from '../../src/runners/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { groundBefore, type MigrationGround } from '../helpers/migration-ground.js';

const TAG = '0515_a_runner_is_born_queued_for_setup';

async function setupOf(runnerId: string) {
  const [row] = await rows<{
    provision_status: string | null;
    provision_requested_at: Date | null;
  }>(sql`SELECT provision_status, provision_requested_at FROM runners WHERE id = ${runnerId}`);
  return row;
}

describe('a runner made through either door', () => {
  let ownerToken: string;
  let boxToken: string;
  let projectId: string;
  let deviceId: string;

  beforeAll(() => {
    bootstrapRunnerAdapters();
  });

  beforeEach(async () => {
    await truncateAll();
    const owner = (await createTestUser({ verified: true })).id;
    projectId = (await createTestProject(owner)).id;
    deviceId = await createTestDevice(owner, { status: 'online' });
    ownerToken = await userToken(owner);
    boxToken = (await mintPat({ permissions: ['*'], userId: owner, name: 'box', deviceId }))
      .plaintext;
  });

  const create = () =>
    api(ownerToken, 'POST', '/api/runners', {
      projectId,
      type: 'claude-code',
      name: 'adminhub box',
      deviceId,
    });

  const queuedForTheBox = async () => {
    const res = await api(boxToken, 'GET', '/api/devices/me/provisions');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as unknown as Array<{ runnerId: string }>).map((p) => p.runnerId);
  };

  it('POST /api/runners makes a row queued for setup, which its box is then given', async () => {
    const res = await create();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const runnerId = (res.body.runner as { id: string }).id;

    const setup = await setupOf(runnerId);
    expect(setup?.provision_status).toBe('queued');
    expect(setup?.provision_requested_at).not.toBeNull();
    expect(await queuedForTheBox()).toContain(runnerId);
  });

  it("a box's setup report on that row moves it, and a re-bind queues it again", async () => {
    const runnerId = ((await create()).body.runner as { id: string }).id;

    const ready = await api(
      boxToken,
      'POST',
      `/api/devices/me/runners/${runnerId}/provision-status`,
      { status: 'ready' },
    );
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect((await setupOf(runnerId))?.provision_status).toBe('ready');

    const rebind = await api(ownerToken, 'POST', `/api/projects/${projectId}/runners`, {
      deviceId,
    });
    expect(rebind.status, JSON.stringify(rebind.body)).toBe(201);
    expect((rebind.body as { id: string }).id).toBe(runnerId);
    expect((await setupOf(runnerId))?.provision_status).toBe('queued');
    expect(await queuedForTheBox()).toContain(runnerId);

    const moves = await rows<{ from_status: string | null; to_status: string }>(sql`
      SELECT from_status, to_status FROM kernel_transitions
       WHERE entity = 'runner_provision' AND entity_id = ${runnerId}
       ORDER BY created_at, id
    `);
    expect(moves).toEqual([
      { from_status: 'queued', to_status: 'ready' },
      { from_status: 'ready', to_status: 'queued' },
    ]);
  });

  it("a box's report on a runner that is not its own is refused by name, and nothing moves", async () => {
    const runnerId = ((await create()).body.runner as { id: string }).id;
    const stranger = (await createTestUser({ verified: true })).id;
    const other = await createTestDevice(stranger);
    const otherToken = (
      await mintPat({ permissions: ['*'], userId: stranger, name: 'other', deviceId: other })
    ).plaintext;

    const res = await api(
      otherToken,
      'POST',
      `/api/devices/me/runners/${runnerId}/provision-status`,
      {
        status: 'ready',
      },
    );
    expect(res.status).toBe(404);
    expect((await setupOf(runnerId))?.provision_status).toBe('queued');
  });
});

describe('the migration', () => {
  let ground: MigrationGround;

  beforeAll(async () => {
    ground = await groundBefore(TAG);
  }, 120_000);

  afterAll(async () => {
    await ground.drop();
  });

  it('gives a runner born with no setup status the queued state it stood in, recorded as a kernel move, and refuses NULL from then on', async () => {
    const m = await ground.fresh();
    try {
      const owner = randomUUID();
      const org = randomUUID();
      const project = randomUUID();
      const box = randomUUID();
      const bare = randomUUID();
      const ready = randomUUID();
      await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${owner}, ${`${owner}@forge.test`}, '!x', 'human')`;
      await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${org}, ${`o-${org.slice(0, 8)}`}, 'o', false, ${owner})`;
      await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${project}, ${`p-${project.slice(0, 8)}`}, 'p', ${org}, ${owner})`;
      const second = randomUUID();
      await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${second}, ${`p-${second.slice(0, 8)}`}, 'q', ${org}, ${owner})`;
      await m.sql`INSERT INTO devices (id, owner_id, name, platform, status) VALUES (${box}, ${owner}, 'box', 'linux', 'online')`;
      await m.sql`INSERT INTO runners (id, project_id, type, device_id, name, status) VALUES (${bare}, ${project}, 'claude-code', ${box}, 'bare', 'offline')`;
      await m.sql`INSERT INTO runners (id, project_id, type, device_id, name, status, provision_status) VALUES (${ready}, ${second}, 'claude-code', ${box}, 'ready', 'offline', 'ready')`;

      await m.migrate();

      const rowsAfter = await m.sql<
        Array<{ id: string; provision_status: string; provision_requested_at: Date | null }>
      >`SELECT id, provision_status, provision_requested_at FROM runners ORDER BY name`;
      expect(rowsAfter.map((r) => [r.id, r.provision_status])).toEqual([
        [bare, 'queued'],
        [ready, 'ready'],
      ]);
      expect(rowsAfter[0]?.provision_requested_at).not.toBeNull();

      const moves = await m.sql<
        Array<{ entity_id: string; from_status: string | null; to_status: string; source: string }>
      >`
        SELECT entity_id, from_status, to_status, source FROM kernel_transitions WHERE entity = 'runner_provision'
      `;
      expect(moves).toEqual([
        { entity_id: bare, from_status: null, to_status: 'queued', source: 'migration' },
      ]);

      const [column] = await m.sql<Array<{ is_nullable: string; column_default: string | null }>>`
        SELECT is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'runners' AND column_name = 'provision_status'
      `;
      expect(column?.is_nullable).toBe('NO');
      expect(column?.column_default).toContain('queued');
    } finally {
      await m.drop();
    }
  });
});
