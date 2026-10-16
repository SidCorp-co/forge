/**
 * Migration 0503, run by drizzle's own migrator over the rows a deploy will find. The delivery tools
 * leave the MCP server, so a policy that denied one of them to a profile would deny nothing while the
 * same act stays open over REST: the migration refuses to apply, naming the project, the profile and
 * the entry, and applies over every policy that names none of them.
 */

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0503_delivery_leaves_the_mcp_server';

let ground: MigrationGround;
let m: MigrationDb;
let person: string;
let orgId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  person = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${person}, ${`${person}@forge.test`}, '!x', 'human')`;
  orgId = randomUUID();
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${person})`;
});

afterEach(async () => {
  await m.drop();
});

/** A project whose policy denies `deny` to the `release` profile. */
async function projectDenying(db: postgres.Sql, deny: string[]): Promise<string> {
  const id = randomUUID();
  await db`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${id}, ${`p-${id.slice(0, 8)}`}, 'Atlas', ${orgId}, ${person})`;
  const document = { permissions: { release: { deny } } };
  await db`INSERT INTO project_policies (project_id, revision, document, updated_by) VALUES (${id}, 1, ${db.json(document)}, ${person})`;
  return id;
}

/** The migrator's refusal with the database's own message, which drizzle carries as the cause. */
async function refusal(migrate: Promise<void>): Promise<string> {
  try {
    await migrate;
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
  throw new Error('the migration applied');
}

describe('a policy denying a delivery tool the MCP server no longer serves', () => {
  it.each([
    'mcp__forge__forge_coolify_deploy',
    'mcp__forge__forge_source',
    'mcp__forge__forge_sentry',
    'mcp__forge__forge_storefront_target',
  ])('refuses the deploy naming the project, the profile and %s', async (denied) => {
    const projectId = await projectDenying(m.sql, ['Bash(git push:*)', denied]);
    const said = await refusal(m.migrate());
    expect(said).toContain('POLICY_DENIES_RETIRED_TOOL');
    expect(said).toContain(projectId);
    expect(said).toContain('profile release');
    expect(said).toContain(denied);
  });
});

describe('policies that name no retired tool', () => {
  it('applies, and leaves every policy as it was', async () => {
    const kept = await projectDenying(m.sql, ['mcp__forge__forge_channel', 'mcp__forge__*']);
    await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${randomUUID()}, ${'p-bare'}, 'Bare', ${orgId}, ${person})`;
    await m.migrate();
    const [row] = await m.sql<{ document: unknown }[]>`
      SELECT document FROM project_policies WHERE project_id = ${kept}`;
    expect(row?.document).toEqual({
      permissions: { release: { deny: ['mcp__forge__forge_channel', 'mcp__forge__*'] } },
    });
  });
});
