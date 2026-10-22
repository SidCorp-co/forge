/**
 * ISS-1339 — the live commit endpoint leaves the project's environments, and a release reads its
 * probe from the live deploy binding alone. Through a real database and the real app, because each
 * claim here is about what Postgres holds or what a route answers:
 *
 * - migration 0358, replayed against seeded rows: what it strips, and the rows it refuses by name;
 * - a project whose binding declares the probe reads it, and reads none once the probe is gone;
 * - an environments write naming the retired field is refused by name and writes nothing.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let channelMod: typeof import('../../src/release-batch/channel.js');
let migration: string;
let probe: Server;
let probeUrl = '';
let ownerId: string;
let orgId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const [jwt, channel] = await Promise.all([
    import('../../src/auth/jwt.js'),
    import('../../src/release-batch/channel.js'),
  ]);
  signUserToken = jwt.signUserToken;
  channelMod = channel;
  migration = await readFile(
    new URL('../../drizzle/migrations/0358_the_probe_moves_to_the_binding.sql', import.meta.url),
    'utf8',
  );
  probe = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sourceCommit: 'abc1234def' }));
  });
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (probe) await new Promise<void>((done) => probe.close(() => done()));
  await server?.close?.();
  await harness?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  orgId = (await seedOrg(harness.db, ownerId)).id;
});

async function project(slug: string, environments: Record<string, unknown>): Promise<string> {
  const p = await createTestProject(harness.db, ownerId, { orgId, slug, environments });
  await createTestProjectMember(harness.db, { userId: ownerId, projectId: p.id, role: 'admin' });
  return p.id;
}

interface Binding {
  stages?: string[];
  config?: Record<string, unknown>;
  active?: boolean;
  connectionConfig?: Record<string, unknown>;
}

async function bind(projectId: string, b: Binding = {}): Promise<string> {
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config)
    VALUES (${connection}, 'user', ${ownerId}, 'coolify', true, ${JSON.stringify(b.connectionConfig ?? {})}::jsonb)
  `);
  const id = randomUUID();
  const stages = b.stages ?? ['live'];
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, active, config)
    VALUES (${id}, ${connection}, ${projectId}, 'coolify', 'deploy',
            ${sql.raw(`ARRAY[${stages.map((s) => `'${s}'`).join(',')}]::text[]`)},
            ${b.active ?? true}, ${JSON.stringify(b.config ?? {})}::jsonb)
  `);
  return id;
}

const verifying = (url: string, commitPath?: string) => ({
  verify: { probes: [commitPath ? { url, commitPath } : { url }], stableReads: 1 },
});

async function stored(id: string): Promise<unknown> {
  const rows = await harness.db.execute<{ environments: unknown }>(
    sql`SELECT environments FROM projects WHERE id = ${id}`,
  );
  return rows[0]?.environments;
}

async function runMigration(): Promise<string | null> {
  try {
    await harness.db.execute(sql.raw(migration));
    return null;
  } catch (err) {
    const parts: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message);
    return parts.join('\n');
  }
}

describe('migration 0358 strips what nothing reads', () => {
  it('removes empty keys from every row and keeps the rest of the live side', async () => {
    const a = await project('empty-nulls', {
      live: { url: 'https://a.test', commitUrl: null, commitPath: null },
      limits: 'kept',
    });
    const b = await project('empty-strings', {
      live: { url: null, commitUrl: '', commitPath: '' },
    });
    const c = await project('path-alone', {
      live: { apiUrl: 'https://api.c.test', commitPath: 'x' },
    });
    expect(await runMigration()).toBeNull();
    expect(await stored(a)).toEqual({ live: { url: 'https://a.test' }, limits: 'kept' });
    expect(await stored(b)).toEqual({ live: { url: null } });
    expect(await stored(c)).toEqual({ live: { apiUrl: 'https://api.c.test' } });
  });

  it('removes a stored url every live binding of its project already declares', async () => {
    const id = await project('declared', {
      live: { url: 'https://d.test', commitUrl: probeUrl, commitPath: 'sourceCommit' },
    });
    await bind(id, { config: verifying(probeUrl, 'sourceCommit') });
    await bind(id, { config: verifying('https://other.test/health') });
    await bind(id, { stages: ['preview'] });
    await bind(id, { active: false });
    expect(await runMigration()).toBeNull();
    expect(await stored(id)).toEqual({ live: { url: 'https://d.test' } });
  });

  it('reads a verify declared at the connection tier as the binding declaring it', async () => {
    const id = await project('connection-tier', { live: { commitUrl: probeUrl } });
    await bind(id, { connectionConfig: verifying(probeUrl) });
    expect(await runMigration()).toBeNull();
    expect(await stored(id)).toEqual({ live: {} });
  });
});

describe('migration 0358 refuses a row whose release reads the stored url, writing nothing', () => {
  async function refused(
    seed: (id: string) => Promise<void>,
  ): Promise<{ error: string | null; id: string; other: string }> {
    const other = await project('aa-strippable', {
      live: { url: 'https://o.test', commitUrl: null },
    });
    const id = await project('zz-load-bearing', {
      live: { url: 'https://z.test', commitUrl: probeUrl, commitPath: 'sourceCommit' },
    });
    await seed(id);
    return { error: await runMigration(), id, other };
  }

  it.each([
    ['no live binding at all', async (_id: string) => {}],
    [
      'a live binding that declares no verify',
      async (id: string) => {
        await bind(id, { config: verifying(probeUrl, 'sourceCommit') });
        await bind(id, { config: { releaseRunnerLabel: 'box' } });
      },
    ],
    [
      'live bindings declaring only another url',
      async (id: string) => {
        await bind(id, { config: verifying('https://elsewhere.test/version', 'sourceCommit') });
      },
    ],
    [
      'a binding declaring the url under another commitPath',
      async (id: string) => {
        await bind(id, { config: verifying(probeUrl, 'commit') });
      },
    ],
  ])('%s', async (_case, seed) => {
    const { error, id, other } = await refused(seed);
    expect(error).toContain('0358');
    expect(error).toContain(id);
    expect(error).toContain('zz-load-bearing');
    expect(error).toContain(probeUrl);
    expect(error).toContain('verify.probes');
    expect(await stored(other)).toEqual({ live: { url: 'https://o.test', commitUrl: null } });
    expect(await stored(id)).toEqual({
      live: { url: 'https://z.test', commitUrl: probeUrl, commitPath: 'sourceCommit' },
    });
  });

  it('refuses a stored url with no path that a binding declares with an empty path, which reads another key', async () => {
    const id = await project('zz-whole-body', { live: { commitUrl: probeUrl } });
    await bind(id, { config: { verify: { probes: [{ url: probeUrl, commitPath: '' }] } } });
    const error = await runMigration();
    expect(error).toContain('zz-whole-body');
    expect(await stored(id)).toEqual({ live: { commitUrl: probeUrl } });
  });
});

describe('a release reads the probe its live binding declares, and nothing else', () => {
  it('reads the binding probe, and reads none once the probe is removed', async () => {
    const id = await project('probed', { live: { url: 'https://p.test' } });
    const binding = await bind(id, { config: verifying(probeUrl, 'sourceCommit') });

    const probed = await channelMod.resolveReleaseChannels(id);
    expect(probed.map((c) => c.verifySource)).toEqual(['binding']);
    expect(probed[0]?.verify?.probes).toEqual([{ url: probeUrl, commitPath: 'sourceCommit' }]);
    const verification = channelMod.closeVerification(probed);
    expect(verification.kind).toBe('probed');

    await harness.db.execute(
      sql`UPDATE integration_bindings SET config = config - 'verify' WHERE id = ${binding}`,
    );
    const bare = await channelMod.resolveReleaseChannels(id);
    expect(bare.map((c) => c.verifySource)).toEqual(['none']);
    expect(channelMod.closeVerification(bare).kind).toBe('unverified');
  });

  it('answers readiness with the binding as the probe source and no commit-endpoint gap', async () => {
    const id = await project('ready', { live: { url: 'https://r.test' } });
    await harness.db.execute(sql`
      UPDATE projects
         SET base_branch = 'main', repo_path = '/srv/app',
             release_chain = '[{"branch": "main"}, {"branch": "production", "from": "merge-branch"}]'::jsonb
       WHERE id = ${id}
    `);
    await bind(id, { config: verifying(probeUrl, 'sourceCommit') });
    const res = await call('GET', `/api/projects/${id}/release-readiness`);
    expect(res.status).toBe(200);
    expect(res.json.verifySources).toEqual(['binding']);
    expect(JSON.stringify(res.json.gaps)).not.toContain('commit');
  });
});

async function call(
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await signUserToken(ownerId)}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe('an environments write naming the retired field is refused by name', () => {
  it.each([
    ['commitUrl', 'https://api.x.test/version'],
    ['commitUrl', null],
    ['commitPath', 'sourceCommit'],
    ['commitPath', null],
  ])('refuses live.%s = %j and writes nothing', async (key, value) => {
    const id = await project('refusing', { live: { url: 'https://x.test' }, limits: 'none' });
    const before = await stored(id);
    const base = (await call('GET', `/api/projects/${id}/environments`)).json.environments;
    const res = await call('PATCH', `/api/projects/${id}/environments`, {
      base,
      patch: { live: { [key]: value }, limits: 'changed' },
    });
    expect(res.status).toBe(400);
    const said = JSON.stringify(res.json);
    expect(said).toContain(`live.${key}`);
    expect(said).toContain('retired');
    expect(said).toContain('verify.probes');
    expect(await stored(id)).toEqual(before);
  });

  it('still takes a write of the live url', async () => {
    const id = await project('accepting', { live: { url: 'https://x.test' } });
    const base = (await call('GET', `/api/projects/${id}/environments`)).json.environments;
    const res = await call('PATCH', `/api/projects/${id}/environments`, {
      base,
      patch: { live: { url: 'https://y.test' } },
    });
    expect(res.status).toBe(200);
    expect(await stored(id)).toEqual({ live: { url: 'https://y.test' } });
  });
});
