/**
 * ISS-1104, migration 0625: a plugin client names its version in `x-forge-plugin` and core records
 * it, with when it heard it, on the row the request authenticated as: the paired box for a box's
 * token, else the personal token itself. The owner reads it on `/api/me/devices` and `/api/pat`. A
 * value that is not a version is refused by name at the gate, whatever credential carried it; a
 * request that names none records nothing.
 */

import { randomUUID } from 'node:crypto';
import { PLUGIN_VERSION_HEADER } from '@forge/contracts/plugin-version';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { pluginVersionWritesSettled } from '../../src/middleware/plugin-version.js';
import { api, userToken } from '../helpers/api.js';
import { createTestDevice, createTestUser, truncateAll } from '../helpers/factories.js';
import { groundBefore, type MigrationGround } from '../helpers/migration-ground.js';

const TAG = '0625_a_caller_names_its_plugin';

describe('the migration', () => {
  let ground: MigrationGround;

  beforeAll(async () => {
    ground = await groundBefore(TAG);
  }, 120_000);

  afterAll(async () => {
    await ground.drop();
  });

  it('gives every box and token already there no version heard', async () => {
    const m = await ground.fresh();
    try {
      const owner = randomUUID();
      const box = randomUUID();
      const token = randomUUID();
      await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${owner}, ${`${owner}@forge.test`}, '!x', 'human')`;
      await m.sql`INSERT INTO devices (id, owner_id, name, platform, status) VALUES (${box}, ${owner}, 'paired-before', 'linux', 'online')`;
      await m.sql`INSERT INTO personal_access_tokens (id, user_id, name, token_hash, token_prefix) VALUES (${token}, ${owner}, 'minted-before', 'x', 'forge_pat_x')`;

      await m.migrate();

      const columns = await m.sql<
        Array<{ table_name: string; column_name: string; data_type: string }>
      >`
        SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_name IN ('devices', 'personal_access_tokens')
           AND column_name IN ('plugin_version', 'plugin_seen_at')
         ORDER BY table_name, column_name
      `;
      expect(columns.map((c) => ({ ...c }))).toEqual([
        {
          table_name: 'devices',
          column_name: 'plugin_seen_at',
          data_type: 'timestamp with time zone',
        },
        { table_name: 'devices', column_name: 'plugin_version', data_type: 'text' },
        {
          table_name: 'personal_access_tokens',
          column_name: 'plugin_seen_at',
          data_type: 'timestamp with time zone',
        },
        { table_name: 'personal_access_tokens', column_name: 'plugin_version', data_type: 'text' },
      ]);
      const [device] = await m.sql<Array<{ plugin_version: string | null }>>`
        SELECT plugin_version FROM devices WHERE id = ${box}
      `;
      const [pat] = await m.sql<Array<{ plugin_version: string | null }>>`
        SELECT plugin_version FROM personal_access_tokens WHERE id = ${token}
      `;
      expect(device?.plugin_version).toBeNull();
      expect(pat?.plugin_version).toBeNull();
    } finally {
      await m.drop();
    }
  });
});

describe('a plugin client naming its version', () => {
  let ownerId: string;
  let deviceId: string;
  let boxToken: string;
  let personalToken: string;
  let personalTokenId: string;
  let ownerSession: string;

  beforeEach(async () => {
    await truncateAll();
    ownerId = (await createTestUser({ verified: true })).id;
    deviceId = await createTestDevice(ownerId, { status: 'online' });
    boxToken = (
      await mintPat({
        permissions: ['*'],
        userId: ownerId,
        name: 'box',
        deviceId,
        grantEpoch: PAT_GRANT_EPOCH,
      })
    ).plaintext;
    const minted = await mintPat({
      permissions: ['*'],
      userId: ownerId,
      name: 'laptop',
      grantEpoch: PAT_GRANT_EPOCH,
    });
    personalToken = minted.plaintext;
    personalTokenId = minted.row.id;
    ownerSession = await userToken(ownerId);
  });

  async function shownDevice() {
    const res = await api(ownerSession, 'GET', '/api/me/devices');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = res.body as unknown as Array<{
      id: string;
      pluginVersion: string | null;
      pluginSeenAt: string | null;
    }>;
    return list.find((d) => d.id === deviceId);
  }

  async function shownToken() {
    const res = await api(ownerSession, 'GET', '/api/pat');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { tokens } = res.body as unknown as {
      tokens: Array<{ id: string; pluginVersion: string | null; pluginSeenAt: string | null }>;
    };
    return tokens.find((t) => t.id === personalTokenId);
  }

  it("records a box token's version on the box, and its owner reads it", async () => {
    expect((await shownDevice())?.pluginVersion).toBeNull();
    const res = await api(boxToken, 'GET', '/api/me/devices', undefined, {
      [PLUGIN_VERSION_HEADER]: '3.36.700',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await pluginVersionWritesSettled();

    const device = await shownDevice();
    expect(device?.pluginVersion).toBe('3.36.700');
    expect(device?.pluginSeenAt).not.toBeNull();
  });

  it('records a personal token’s version on the token, never on a box', async () => {
    const res = await api(personalToken, 'GET', '/api/me/devices', undefined, {
      [PLUGIN_VERSION_HEADER]: '3.37.0-rc.1',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await pluginVersionWritesSettled();

    const token = await shownToken();
    expect(token?.pluginVersion).toBe('3.37.0-rc.1');
    expect(token?.pluginSeenAt).not.toBeNull();
    expect((await shownDevice())?.pluginVersion).toBeNull();
  });

  it('records nothing for a call that names no version', async () => {
    const res = await api(boxToken, 'GET', '/api/me/devices');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await pluginVersionWritesSettled();
    expect((await shownDevice())?.pluginVersion).toBeNull();
  });

  it('refuses a value that is not a version by name, on a token and on a session alike', async () => {
    for (const credential of [boxToken, personalToken, ownerSession]) {
      const res = await api(credential, 'GET', '/api/me/devices', undefined, {
        [PLUGIN_VERSION_HEADER]: 'latest',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe('PLUGIN_VERSION_MALFORMED');
    }
    await pluginVersionWritesSettled();
    expect((await shownDevice())?.pluginVersion).toBeNull();
  });

  it('answers a caller with no credential 401 before it reads the version', async () => {
    const res = await api(null, 'GET', '/api/me/devices', undefined, {
      [PLUGIN_VERSION_HEADER]: 'latest',
    });
    expect(res.status).toBe(401);
  });
});
