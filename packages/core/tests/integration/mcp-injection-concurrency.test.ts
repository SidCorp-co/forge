/**
 * ISS-1038 criterion 5 — two providers switched on from the same starting map
 * both survive, against real Postgres.
 *
 * This is the property the whole write design exists for. `updatePipelineConfig`
 * replaces `mcpServers` wholesale from a map the caller read earlier, so two
 * panel writes built on one fetched config would each carry the other's absence
 * and the later one would silently drop the earlier one's key — the
 * `wholesale-config-clobber` affordance. `setMcpServerSentinel` changes ONE
 * jsonb key in ONE statement instead, so the two cannot see each other's map
 * at all.
 *
 * A unit test cannot show this: the losing write is a real concurrent UPDATE on
 * a real row, and a mocked `db.execute` has no row to lose.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  setMcpServerSentinel: typeof import('../../src/pipeline/pipeline-config-service.js').setMcpServerSentinel;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  updatePipelineConfig: typeof import('../../src/pipeline/pipeline-config-service.js').updatePipelineConfig;
};

let testDb: TestDatabase;
let mods: Mods;
let projectId: string;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  mods = (await import('../../src/pipeline/pipeline-config-service.js')) as unknown as Mods;
});

afterAll(async () => {
  await testDb?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(testDb.db);
  const user = await createTestUser(testDb.db);
  const project = await createTestProject(testDb.db, user.id);
  projectId = project.id;
});

/** The stored map, read straight out of the jsonb column. */
async function storedServers(): Promise<Record<string, unknown>> {
  const rows = await testDb.db.execute(
    sql`SELECT agent_config -> 'pipelineConfig' -> 'mcpServers' AS m
        FROM projects WHERE id = ${projectId}`,
  );
  const row =
    (rows as unknown as { rows?: Array<{ m: unknown }> }).rows ??
    (rows as unknown as Array<{ m: unknown }>);
  return ((row[0]?.m ?? {}) as Record<string, unknown>) ?? {};
}

/** Seed the non-sentinel half through the ordinary patch, and any integration
 *  sentinel through its own writer — which is the only door that writes one. */
async function seed(mcpServers: Record<string, unknown>): Promise<void> {
  const plain: Record<string, unknown> = {};
  const sentinels: string[] = [];
  for (const [name, value] of Object.entries(mcpServers)) {
    if (value === true && MCP_SENTINELS.includes(name)) sentinels.push(name);
    else plain[name] = value;
  }
  await mods.updatePipelineConfig({ projectId, patch: { mcpServers: plain } as never });
  for (const name of sentinels) {
    await mods.setMcpServerSentinel({ projectId, name, enabled: true });
  }
}

const MCP_SENTINELS = ['postman', 'epodsystem', 'sentry'];

describe('setMcpServerSentinel against real Postgres (ISS-1038)', () => {
  it('two providers switched on from the same starting map both survive', async () => {
    await seed({ playwright: true });

    // Both writes are issued without either having read the other's result —
    // the shape two operators on two tabs produce.
    await Promise.all([
      mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: true }),
      mods.setMcpServerSentinel({ projectId, name: 'sentry', enabled: true }),
    ]);

    const stored = await storedServers();
    expect(stored.epodsystem).toBe(true);
    expect(stored.sentry).toBe(true);
    // And the key neither write named is untouched.
    expect(stored.playwright).toBe(true);
  });

  it('creates the mcpServers map on a project that has no pipelineConfig at all', async () => {
    await mods.setMcpServerSentinel({ projectId, name: 'postman', enabled: true });
    expect(await storedServers()).toEqual({ postman: true });
  });

  it('writes the bare boolean — nothing else lands under the key', async () => {
    await mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: true });
    const stored = await storedServers();
    expect(stored.epodsystem).toBe(true);
    // No credential, no rendered spec: the whole stored map serialises to the
    // sentinel and nothing more.
    expect(JSON.stringify(stored)).toBe('{"epodsystem":true}');
  });

  it('clearing one provider leaves every other key exactly as stored', async () => {
    await seed({
      playwright: true,
      'chrome-devtools-mcp': { type: 'stdio', command: 'npx' },
      epodsystem: true,
      sentry: true,
    });

    await mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: false });

    const stored = await storedServers();
    expect(stored.epodsystem).toBeUndefined();
    expect(stored.sentry).toBe(true);
    expect(stored.playwright).toBe(true);
    expect(stored['chrome-devtools-mcp']).toEqual({ type: 'stdio', command: 'npx' });
  });

  it('switching OFF removes a LABELLED sentinel, not only the bare name', async () => {
    // Review F1. `projectDeclaredProviders` reads `epodsystem_store_a: true` as
    // Epodsystem being declared, and the resolver injects against it — so a
    // switch that deleted only the bare `epodsystem` key would leave the panel
    // showing a control that changes nothing, which is this issue's own defect
    // one level down.
    await seed({ playwright: true });
    await testDb.db.execute(
      sql`UPDATE projects
          SET agent_config = jsonb_set(agent_config, ARRAY['pipelineConfig','mcpServers'],
              '{"playwright":true,"epodsystem_store_a":true}'::jsonb, true)
          WHERE id = ${projectId}`,
    );
    expect((await storedServers()).epodsystem_store_a).toBe(true);

    await mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: false });

    const stored = await storedServers();
    expect(stored.epodsystem_store_a).toBeUndefined();
    expect(stored.playwright).toBe(true);
  });

  it('switching OFF leaves an object spec stored under a matching name alone', async () => {
    // An object value is a raw custom server, not a sentinel: the resolvers
    // test for `=== true` and would inject no credential for it. This switch
    // does not own it.
    await seed({ playwright: true });
    await testDb.db.execute(
      sql`UPDATE projects
          SET agent_config = jsonb_set(agent_config, ARRAY['pipelineConfig','mcpServers'],
              '{"epodsystem":true,"epodsystem_custom":{"type":"stdio"}}'::jsonb, true)
          WHERE id = ${projectId}`,
    );

    await mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: false });

    const stored = await storedServers();
    expect(stored.epodsystem).toBeUndefined();
    expect(stored.epodsystem_custom).toEqual({ type: 'stdio' });
  });

  it('succeeds against a project whose stored config was already invalid', async () => {
    // Review F3. `assertMergedConfigValid` deliberately lets an edit through
    // when the STORED document already fails the schema — the write did not
    // cause that and refusing would leave the operator no way to edit out of
    // it. What must not happen is the write committing and the call then
    // reporting failure, which is state lying about itself.
    await testDb.db.execute(
      sql`UPDATE projects
          SET agent_config = '{"pipelineConfig":{"states":{"open":{"enabled":"yes-please"}}}}'::jsonb
          WHERE id = ${projectId}`,
    );

    await expect(
      mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: true }),
    ).resolves.toBeUndefined();
    expect((await storedServers()).epodsystem).toBe(true);
  });

  it('is idempotent — switching on twice leaves one key with one value', async () => {
    await mods.setMcpServerSentinel({ projectId, name: 'sentry', enabled: true });
    await mods.setMcpServerSentinel({ projectId, name: 'sentry', enabled: true });
    expect(await storedServers()).toEqual({ sentry: true });
  });

  it('clearing a provider that was never set is a no-op rather than an error', async () => {
    await seed({ playwright: true });
    await mods.setMcpServerSentinel({ projectId, name: 'postman', enabled: false });
    expect(await storedServers()).toEqual({ playwright: true });
  });
});

describe('the Pipeline tab against the Integrations panel (ISS-1038)', () => {
  const staleSave = (mcpServers: Record<string, unknown>) =>
    mods.updatePipelineConfig({ projectId, patch: { mcpServers } as never });

  it('refuses BY NAME a save whose map has lost a sentinel, and changes nothing', async () => {
    // The shape the review named. An operator opens the Pipeline tab, someone
    // switches Epodsystem on from the Integrations panel, and the first
    // operator then saves an unrelated catalog change from the config they
    // fetched a minute ago. That map has no `epodsystem` in it.
    await seed({ playwright: true });
    await mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: true });

    await expect(
      staleSave({ playwright: true, 'chrome-devtools-mcp': true }),
    ).rejects.toMatchObject({ code: 'MCP_SENTINEL_NOT_WRITABLE_HERE' });

    const stored = await storedServers();
    // The sentinel is intact — `pixelight` and `butlocs` carry one today and a
    // save about something else must not take it away.
    expect(stored.epodsystem).toBe(true);
    // And the refused write landed NOTHING, rather than half of it.
    expect(stored['chrome-devtools-mcp']).toBeUndefined();
    expect(stored.playwright).toBe(true);
  });

  it('names the provider and where its switch lives', async () => {
    await seed({ playwright: true });
    await mods.setMcpServerSentinel({ projectId, name: 'sentry', enabled: true });
    await expect(staleSave({ playwright: true })).rejects.toMatchObject({
      message: expect.stringContaining('sentry'),
    });
    await expect(staleSave({ playwright: true })).rejects.toMatchObject({
      message: expect.stringContaining('Settings → Integrations'),
    });
  });

  it('accepts a save that round-trips the stored sentinel unchanged', async () => {
    // What the Pipeline tab actually sends: the map it fetched, sentinels and
    // all, plus the operator's edit. This must keep working.
    await seed({ playwright: true });
    await mods.setMcpServerSentinel({ projectId, name: 'epodsystem', enabled: true });

    await staleSave({ playwright: true, epodsystem: true, 'chrome-devtools-mcp': true });

    const stored = await storedServers();
    expect(stored.epodsystem).toBe(true);
    expect(stored['chrome-devtools-mcp']).toBe(true);
  });

  it('refuses a save that tries to ADD a sentinel through this door', async () => {
    await seed({ playwright: true });
    await expect(staleSave({ playwright: true, postman: true })).rejects.toMatchObject({
      code: 'MCP_SENTINEL_NOT_WRITABLE_HERE',
    });
    expect((await storedServers()).postman).toBeUndefined();
  });

  it('leaves an OBJECT spec under an integration name alone — it is a custom server', async () => {
    // `expandMcpServers` passes an object through verbatim and the resolvers
    // test for `=== true`, so this injects no credential and is not a sentinel.
    await seed({ playwright: true });
    await staleSave({ playwright: true, sentry: { type: 'stdio', command: 'npx' } });
    expect((await storedServers()).sentry).toEqual({ type: 'stdio', command: 'npx' });
  });
});
