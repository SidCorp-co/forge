/**
 * Facts a box reports and core judges or serves (ADR 0009). Migration 0430: a box reports what each
 * scratch filesystem has left on its heartbeat, core judges it against its own thresholds and shows
 * the verdict on `/api/me/devices`. Core serves the checkout orientation on `me/runners`, so the box
 * writes what it is sent. The lease answer carries only the lease, now that no paired box reads the
 * issue's standing off it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { DISK_CRITICAL_FREE_PERCENT, DISK_WIRE_ROOTS } from '../../src/devices/disk-report.js';
import { checkoutOrientation } from '../../src/prompt/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { groundBefore, type MigrationGround } from '../helpers/migration-ground.js';

const TAG = '0430_a_box_reports_what_its_scratch_has_left';

describe('the migration', () => {
  let ground: MigrationGround;

  beforeAll(async () => {
    ground = await groundBefore(TAG);
  }, 120_000);

  afterAll(async () => {
    await ground.drop();
  });

  it('gives every box already paired a disk report of null, one that never reported', async () => {
    const m = await ground.fresh();
    try {
      const owner = randomUUID();
      const box = randomUUID();
      await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${owner}, ${`${owner}@forge.test`}, '!x', 'human')`;
      await m.sql`INSERT INTO devices (id, owner_id, name, platform, status) VALUES (${box}, ${owner}, 'paired-before', 'linux', 'online')`;

      await m.migrate();

      const [column] = await m.sql<Array<{ data_type: string; is_nullable: string }>>`
        SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_name = 'devices' AND column_name = 'disk_report'
      `;
      expect(column).toEqual({ data_type: 'jsonb', is_nullable: 'YES' });
      const [row] = await m.sql<Array<{ disk_report: unknown }>>`
        SELECT disk_report FROM devices WHERE id = ${box}
      `;
      expect(row?.disk_report).toBeNull();
    } finally {
      await m.drop();
    }
  });
});

describe('a box reporting its facts', () => {
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

  async function shownDisk(): Promise<Record<string, unknown> | null | undefined> {
    const res = await api(ownerToken, 'GET', '/api/me/devices');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = res.body as unknown as Array<{ id: string; disk: Record<string, unknown> | null }>;
    return list.find((d) => d.id === deviceId)?.disk;
  }

  const tmp = (inodesFree: number) => ({
    root: '/tmp',
    bytesFree: 30 * 1024 ** 3,
    bytesTotal: 61 * 1024 ** 3,
    inodesFree,
    inodesTotal: 1_000_000,
  });

  it('reads null for a box that has not reported its disk, never clear', async () => {
    expect((await beat({})).status).toBe(200);
    expect(await shownDisk()).toBeNull();
  });

  it("judges the box's reading with core's thresholds and shows the owner the verdict", async () => {
    const res = await beat({ disk: { roots: [tmp((DISK_CRITICAL_FREE_PERCENT - 4) * 10_000)] } });

    expect(res.status).toBe(200);
    expect(res.body.disk).toEqual({ accepted: true });
    const disk = await shownDisk();
    expect(disk).toMatchObject({
      verdict: 'critical',
      criticalFreePercent: DISK_CRITICAL_FREE_PERCENT,
    });
    expect((disk?.roots as unknown[] | undefined)?.[0]).toMatchObject({
      root: '/tmp',
      verdict: 'critical',
      axis: 'inodes',
      bytesFreePercent: 49,
    });
  });

  it('keeps the last reading when a beat says nothing about the disk', async () => {
    await beat({ disk: { roots: [tmp(900_000)] } });
    await beat({ agentVersion: '0.4.0' });
    expect(await shownDisk()).toMatchObject({ verdict: 'clear' });
  });

  it('refuses a report it cannot read by name, stores nothing, and still lands the beat', async () => {
    const res = await beat({
      disk: { roots: Array.from({ length: DISK_WIRE_ROOTS + 1 }, () => tmp(500_000)) },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.disk).toMatchObject({ accepted: false });
    expect(String((res.body.disk as { reason: string }).reason)).toMatch(/^disk\.roots/);
    const [row] = await rows<{ disk_report: unknown }>(
      sql`SELECT disk_report FROM devices WHERE id = ${deviceId}`,
    );
    expect(row?.disk_report).toBeNull();
  });

  it("serves each assigned project's checkout orientation on me/runners", async () => {
    const project = await createTestProject(ownerId);
    await bindTestRunner(project.id, deviceId);

    const res = await api(boxToken, 'GET', '/api/devices/me/runners');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = res.body as unknown as Array<{ slug: string; orientation: string }>;
    expect(row?.orientation).toBe(checkoutOrientation(project.id, project.slug));
  });

  it('answers a lease read with the lease alone, no issue standing beside it', async () => {
    const project = await createTestProject(ownerId);
    await bindTestRunner(project.id, deviceId);

    const res = await api(
      boxToken,
      'GET',
      `/api/devices/me/issue-leases/ISS-1?projectId=${project.id}`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ held: false, heldByThisDevice: false, holder: null });
  });
});
