/**
 * Migration 0580, run by drizzle's own migrator over the documents a deploy can find (ISS-876, owner
 * 2026-11-02: no daily cap on handing work). `fixesPerUserPerDay` left the strict `limits` of a
 * Rocket.Chat `support` and `agent` block; the five chat bindings stored it as 1000, so the migration
 * strips it from every stored binding and connection config, and each document validates again.
 */

import { randomUUID } from 'node:crypto';
import { rocketchatBindingTargetShape } from '@forge/contracts/support-channel';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0580_a_support_group_counts_no_changes_a_day';

// the binding door's own shape for a Rocket.Chat target, the groups and who answers them
const target = z.object(rocketchatBindingTargetShape);

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
let connectionId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  const userId = randomUUID();
  const orgId = randomUUID();
  projectId = randomUUID();
  connectionId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO integration_connections (id, owner_type, owner_id, provider, config) VALUES (${connectionId}, 'user', ${userId}, 'rocketchat', ${m.sql.json(
    {
      serverUrl: 'https://chat.example.test',
      support: { limits: { fixesPerUserPerDay: 1000 } },
    },
  )})`;
});

afterEach(async () => {
  await m.drop();
});

async function binding(label: string, config: Record<string, unknown>): Promise<string> {
  const [row] = await m.sql<{ id: string }[]>`
    INSERT INTO integration_bindings (project_id, connection_id, provider, role, config, label)
    VALUES (${projectId}, ${connectionId}, 'rocketchat', 'service', ${m.sql.json(config as never)}, ${label})
    RETURNING id`;
  return String(row?.id);
}

async function stored(id: string): Promise<{ config: Record<string, unknown>; revision: number }> {
  const [row] = await m.sql<{ config: Record<string, unknown>; revision: number }[]>`
    SELECT config, revision FROM integration_bindings WHERE id = ${id}`;
  if (!row) throw new Error(`binding ${id} is gone`);
  return row;
}

describe('0580: a support group counts no changes a day', () => {
  it('strips the key from every stored block, so each binding validates again', async () => {
    const support = await binding('support', {
      rids: ['GROUP1'],
      support: {
        product: 'Catalog, the shop back office',
        limits: { fixesPerUserPerDay: 1000, messagesPerUserPerHour: 20 },
      },
    });
    const agent = await binding('agent', {
      rids: ['GROUP2'],
      agent: { limits: { fixesPerUserPerDay: 1000 }, grants: { abilities: [], owner: 'u-owner' } },
    });
    const untouched = await binding('untouched', {
      rids: ['GROUP3'],
      support: { limits: { messageMaxChars: 500 } },
    });
    // the stopgap the orchestrator stored no longer reads under the strict limits
    for (const id of [support, agent]) {
      const before = target.safeParse((await stored(id)).config);
      expect(before.success).toBe(false);
      expect(JSON.stringify(before.error?.issues)).toContain('fixesPerUserPerDay');
    }

    await m.migrate();

    expect(await stored(support)).toEqual({
      config: {
        rids: ['GROUP1'],
        support: {
          product: 'Catalog, the shop back office',
          limits: { messagesPerUserPerHour: 20 },
        },
      },
      revision: 2,
    });
    // a `limits` left empty goes with the key
    expect(await stored(agent)).toEqual({
      config: { rids: ['GROUP2'], agent: { grants: { abilities: [], owner: 'u-owner' } } },
      revision: 2,
    });
    // a document that never held it is not written
    expect(await stored(untouched)).toEqual({
      config: { rids: ['GROUP3'], support: { limits: { messageMaxChars: 500 } } },
      revision: 1,
    });
    for (const id of [support, agent, untouched]) {
      const after = target.safeParse((await stored(id)).config);
      expect(after.success, JSON.stringify(after.error?.issues)).toBe(true);
    }
    const [connection] = await m.sql<{ config: Record<string, unknown> }[]>`
      SELECT config FROM integration_connections WHERE id = ${connectionId}`;
    expect(connection?.config).toEqual({ serverUrl: 'https://chat.example.test', support: {} });
  });

  it('leaves a document whose limits are no object, or hold no key, as it is', async () => {
    const odd = await binding('odd', {
      rids: ['GROUP4'],
      support: { limits: 'fixesPerUserPerDay' },
    });
    const bare = await binding('bare', { rids: ['GROUP5'] });
    await m.migrate();
    expect(await stored(odd)).toEqual({
      config: { rids: ['GROUP4'], support: { limits: 'fixesPerUserPerDay' } },
      revision: 1,
    });
    expect(await stored(bare)).toEqual({ config: { rids: ['GROUP5'] }, revision: 1 });
  });
});
