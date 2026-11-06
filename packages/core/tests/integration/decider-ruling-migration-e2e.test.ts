/**
 * Migration 0611, run by drizzle's own migrator over the rows a deploy can find (ISS-1042): migration
 * 0609's room-typed decider columns go, and no live value is dropped unread. Each live channel rule
 * naming a decider becomes a `rule` knowledge entry of its project; one whose writer could name a
 * decider under 0609 (the owner a room of the group names, or a member confirmed as Technical or
 * Maintenance) carries `metadata.deciders`, so its decider still counts; one that did not stand
 * names nobody and keeps what it named under `carriedFrom`. A removed rule carries nothing.
 * Planted red by running the migrator with the carrying INSERT selecting no row: no entry was carried.
 *
 * @direct-test-of packages/core/drizzle/migrations/0611_who_decides_an_act_is_the_projects_ruling.sql
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0611_who_decides_an_act_is_the_projects_ruling';
const OWNER_KEY = 'u-owner';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
let channelId: string;

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
  const connectionId = randomUUID();
  projectId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO integration_connections (id, owner_type, owner_id, provider, config) VALUES (${connectionId}, 'user', ${userId}, 'rocketchat', ${m.sql.json({ serverUrl: 'https://chat.example.test' })})`;
  const [binding] = await m.sql<{ id: string }[]>`
    INSERT INTO integration_bindings (project_id, connection_id, provider, role, config, label)
    VALUES (${projectId}, ${connectionId}, 'rocketchat', 'service',
            ${m.sql.json({ rids: ['GROUP1'], agent: { grants: { abilities: [], owner: OWNER_KEY } } })}, 'support')
    RETURNING id`;
  await m.sql`
    INSERT INTO support_rooms (project_id, binding_id, connection_id, rid, kind, principal_user_id)
    VALUES (${projectId}, ${String(binding?.id)}, ${connectionId}, 'GROUP1', 'agent', ${userId})`;
  const [channel] = await m.sql<{ id: string }[]>`
    INSERT INTO support_channels (project_id, rid) VALUES (${projectId}, 'GROUP1') RETURNING id`;
  channelId = String(channel?.id);
  for (const [username, roles] of [
    ['carol', ['technical']],
    ['dave', ['product']],
  ] as const) {
    await m.sql`
      INSERT INTO support_channel_members (channel_id, username, roles, state)
      VALUES (${channelId}, ${username}, ${m.sql.array([...roles])}, 'confirmed')`;
  }
});

afterEach(async () => {
  await m.drop();
});

/** A channel rule as 0609 kept one naming a decider. */
async function rule(input: {
  author: string;
  authorKey: string;
  decider: string;
  acts: string[];
  removed?: boolean;
}): Promise<string> {
  const message = `m-${randomUUID().slice(0, 8)}`;
  const [row] = await m.sql<{ id: string }[]>`
    INSERT INTO support_channel_rules
      (channel_id, text, author, author_key, message_id, thread, decider, decider_acts, removed_at)
    VALUES (${channelId}, ${`When @${input.decider} asks, do it.`}, ${input.author}, ${input.authorKey},
            ${message}, 't1', ${input.decider}, ${m.sql.array(input.acts)},
            ${input.removed ? new Date() : null})
    RETURNING id`;
  return String(row?.id);
}

const carried = async (ruleId: string) =>
  (
    await m.sql<{ kind: string; metadata: Record<string, unknown>; body: string }[]>`
      SELECT kind, metadata, body FROM knowledge_entries
       WHERE project_id = ${projectId} AND slug = ${`room-decider-${ruleId}`}`
  )[0];

describe('0611: who decides an act is the project’s ruling', () => {
  it('carries each live decider into a ruling, standing where its writer could name one', async () => {
    const byOwner = await rule({ author: 'alice', authorKey: OWNER_KEY, decider: 'tuyen', acts: ['filing'] });
    const byTech = await rule({ author: 'carol', authorKey: 'u-carol', decider: 'erin', acts: ['deploy', 'build'] });
    const byProduct = await rule({ author: 'dave', authorKey: 'u-dave', decider: 'bob', acts: ['filing'] });
    const removed = await rule({ author: 'alice', authorKey: OWNER_KEY, decider: 'zed', acts: ['fix'], removed: true });
    await m.migrate();

    expect(await carried(byOwner)).toMatchObject({
      kind: 'rule',
      metadata: {
        deciders: [{ member: 'tuyen', acts: ['filing'] }],
        carriedFrom: { rule: byOwner, author: 'alice', stood: true },
      },
    });
    expect(await carried(byTech)).toMatchObject({
      metadata: { deciders: [{ member: 'erin', acts: ['deploy', 'build'] }] },
    });
    // a Product member's rule named nobody under 0609, and names nobody now; its words are kept
    const product = await carried(byProduct);
    expect(product?.metadata).not.toHaveProperty('deciders');
    expect(product?.metadata).toMatchObject({
      carriedFrom: { stood: false, decider: { member: 'bob', acts: ['filing'] } },
    });
    expect(product?.body).toContain('names nobody');
    expect(await carried(removed)).toBeUndefined();

    // the columns and their check are gone
    const cols = await m.sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'support_channel_rules'
         AND column_name IN ('decider', 'decider_acts', 'author_key')`;
    expect(cols).toEqual([]);
  });

  it('applies to a project with no rule naming a decider, carrying nothing', async () => {
    await m.sql`
      INSERT INTO support_channel_rules (channel_id, text, author, message_id, thread)
      VALUES (${channelId}, 'Answer in Vietnamese.', 'alice', 'm-plain', 't1')`;
    await m.migrate();
    const entries = await m.sql`SELECT slug FROM knowledge_entries WHERE project_id = ${projectId}`;
    expect(entries).toEqual([]);
    const [kept] = await m.sql<{ text: string }[]>`
      SELECT text FROM support_channel_rules WHERE channel_id = ${channelId}`;
    expect(kept?.text).toBe('Answer in Vietnamese.');
  });
});
