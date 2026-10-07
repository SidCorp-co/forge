/**
 * Migration 0421 and what it opens: a box names, on every heartbeat, each binary a pane needs that it
 * cannot resolve, and its owner reads that picture on `/api/me/devices`. A box that never reported
 * reads `null`, never an empty list that would claim it had nothing missing; a report core cannot
 * read is refused by name in the heartbeat's answer while the beat itself still lands.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { BINARY_WIRE_MAX } from '../../src/devices/binary-report.js';
import { api, userToken } from '../helpers/api.js';
import { createTestDevice, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { groundBefore, type MigrationGround } from '../helpers/migration-ground.js';

const TAG = '0421_a_box_names_the_pane_binaries_it_cannot_resolve';

describe('the migration', () => {
  let ground: MigrationGround;

  beforeAll(async () => {
    ground = await groundBefore(TAG);
  }, 120_000);

  afterAll(async () => {
    await ground.drop();
  });

  it('gives every box already paired a report of null, one that never reported', async () => {
    const m = await ground.fresh();
    try {
      const owner = randomUUID();
      const box = randomUUID();
      await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${owner}, ${`${owner}@forge.test`}, '!x', 'human')`;
      await m.sql`INSERT INTO devices (id, owner_id, name, platform, status) VALUES (${box}, ${owner}, 'paired-before', 'linux', 'online')`;

      await m.migrate();

      const [column] = await m.sql<Array<{ data_type: string; is_nullable: string }>>`
        SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_name = 'devices' AND column_name = 'binary_report'
      `;
      expect(column).toEqual({ data_type: 'jsonb', is_nullable: 'YES' });
      const [row] = await m.sql<Array<{ binary_report: unknown }>>`
        SELECT binary_report FROM devices WHERE id = ${box}
      `;
      expect(row?.binary_report).toBeNull();
    } finally {
      await m.drop();
    }
  });
});

describe('a box reporting its binaries', () => {
  let ownerId: string;
  let deviceId: string;
  let boxToken: string;
  let ownerToken: string;

  beforeEach(async () => {
    await truncateAll();
    ownerId = (await createTestUser({ verified: true })).id;
    deviceId = await createTestDevice(ownerId, { status: 'online' });
    boxToken = (await mintPat({ permissions: ['*'], userId: ownerId, name: 'box', deviceId }))
      .plaintext;
    ownerToken = await userToken(ownerId);
  });

  const beat = (body: Record<string, unknown>) =>
    api(boxToken, 'POST', '/api/devices/heartbeat', body);

  async function shown(): Promise<unknown> {
    const res = await api(ownerToken, 'GET', '/api/me/devices');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = res.body as unknown as Array<{ id: string; binaries: unknown }>;
    return list.find((d) => d.id === deviceId)?.binaries;
  }

  async function stored(): Promise<unknown> {
    const [row] = await rows<{ binary_report: unknown }>(
      sql`SELECT binary_report FROM devices WHERE id = ${deviceId}`,
    );
    return row?.binary_report;
  }

  it('reads null for a box that has not reported, rather than nothing missing', async () => {
    expect((await beat({})).status).toBe(200);
    expect(await shown()).toBeNull();
  });

  it('shows the owner each missing binary with what was looked for, and when it was told', async () => {
    const missing = [{ name: 'claude', detail: 'not on PATH: /usr/local/bin:/usr/bin' }];

    const res = await beat({ binaries: { missing } });

    expect(res.status).toBe(200);
    expect(res.body.binaries).toEqual({ accepted: true });
    const binaries = (await shown()) as { missing: unknown; receivedAt: string };
    expect(binaries.missing).toEqual(missing);
    expect(Number.isNaN(Date.parse(binaries.receivedAt))).toBe(false);
  });

  it('keeps the newest picture, so a box that found its binaries reads nothing missing', async () => {
    await beat({ binaries: { missing: [{ name: 'node', detail: 'not on PATH' }] } });
    await beat({ binaries: { missing: [] } });
    expect(await shown()).toMatchObject({ missing: [] });
  });

  it('keeps the last picture when a beat says nothing about binaries', async () => {
    await beat({ binaries: { missing: [{ name: 'node', detail: 'not on PATH' }] } });
    await beat({ agentVersion: '0.4.0' });
    expect(await shown()).toMatchObject({ missing: [{ name: 'node' }] });
  });

  it('refuses a report it cannot read by name, stores nothing, and still lands the beat', async () => {
    const tooMany = Array.from({ length: BINARY_WIRE_MAX + 1 }, (_, i) => ({
      name: `bin-${i}`,
      detail: 'missing',
    }));

    const res = await beat({ binaries: { missing: tooMany } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.binaries).toMatchObject({ accepted: false });
    expect(String((res.body.binaries as { reason: string }).reason)).toMatch(/^binaries\.missing/);
    expect(await stored()).toBeNull();
  });

  it('refuses a field the report does not have, naming where', async () => {
    const res = await beat({ binaries: { missing: [], extra: true } });
    expect(res.body.binaries).toMatchObject({ accepted: false });
    expect(await stored()).toBeNull();
  });
});
