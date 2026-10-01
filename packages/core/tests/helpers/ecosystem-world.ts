import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { seedContractVersion } from './contract-versions.js';
import { setupTestDatabase, type TestDatabase } from './db.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
} from './factories.js';
import { truncateAll } from './truncate.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
// biome-ignore lint/suspicious/noExplicitAny: documents are patched at arbitrary depth
export type Doc = Record<string, any>;
export type Who = 'platform' | 'plugin' | 'store' | 'viewer';
export type ProjectKey = 'forge' | 'internal' | 'plugin' | 'store';

export interface EcosystemWorld {
  harness: TestDatabase;
  app: Hono<AppVars>;
  token: Record<Who, string>;
  user: Record<Who, string>;
  org: Record<Exclude<Who, 'viewer'>, string>;
  project: Record<ProjectKey, string>;
  eco: string;
  otherEco: string;
  membership: Partial<Record<ProjectKey, string>>;
}

const EXAMPLES = new URL('../../src/ecosystem/fixtures/examples/', import.meta.url);
export const example = (file: string): Doc =>
  JSON.parse(readFileSync(new URL(file, EXAMPLES), 'utf8'));

export async function openWorld(): Promise<EcosystemWorld> {
  const harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
  await truncateAll(harness.db);

  const { signUserToken } = await import('../../src/auth/jwt.js');
  const people = {} as Record<Who, string>;
  const token = {} as Record<Who, string>;
  for (const who of ['platform', 'plugin', 'store', 'viewer'] as const) {
    people[who] = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
    token[who] = await signUserToken(people[who]);
  }
  const org = {
    platform: (await seedOrg(harness.db, people.platform)).id,
    plugin: (await seedOrg(harness.db, people.plugin)).id,
    store: (await seedOrg(harness.db, people.store)).id,
  };
  const make = async (slug: string, owner: keyof typeof org) =>
    (await createTestProject(harness.db, people[owner], { slug, orgId: org[owner] })).id;
  const project = {
    forge: await make('forge', 'platform'),
    internal: await make('forge-internal', 'platform'),
    plugin: await make('forge-plugin', 'plugin'),
    store: await make('store-x', 'store'),
  };
  await createTestProjectMember(harness.db, {
    projectId: project.plugin,
    userId: people.viewer,
    role: 'viewer',
  });

  const { app } = await import('../../src/index.js');
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
  return { harness, app, token, user: people, org, project, eco: '', otherEco: '', membership: {} };
}

export function sender(w: EcosystemWorld) {
  return async (who: Who, method: string, path: string, body?: unknown) => {
    const res = await w.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${w.token[who]}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

export const refusalCodes = (res: { json: Doc }) =>
  (res.json.error?.refusals ?? []).map((r: Doc) => r.code) as string[];

export async function refusedByDb(query: Promise<unknown>, pattern: RegExp) {
  const err = await query.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'the database took the write').not.toBeNull();
  const messages: string[] = [];
  for (
    let e = err as { message?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    messages.push(String(e.message));
  }
  expect(messages.join(' | ')).toMatch(pattern);
}

export function ecosystemDoc(steward: string, slug: string, code: string): Doc {
  const d = example('forge-platform.ecosystem.json');
  delete d.ecosystem.id;
  d.ecosystem.steward = steward;
  d.ecosystem.slug = slug;
  d.channel.code = code;
  return d;
}

export function forgeInterface(w: EcosystemWorld): Doc {
  const d = example('forge.interface.json');
  d.project = w.project.forge;
  for (const p of Object.values(d.publishes) as Doc[]) p.ecosystems = [w.eco];
  d.consumes[0].ecosystem = w.eco;
  return d;
}

export function pluginInterface(w: EcosystemWorld): Doc {
  const d = example('forge-plugin.interface.json');
  d.project = w.project.plugin;
  d.publishes['driver-skill'].ecosystems = [w.eco];
  for (const c of d.consumes) c.ecosystem = w.eco;
  return d;
}

export async function recordVersions(w: EcosystemWorld): Promise<void> {
  const db = w.harness.db;
  await seedContractVersion(db, {
    providerId: w.project.forge,
    ref: 'forge/forge-api',
    version: '2026-09-20',
  });
  await seedContractVersion(db, {
    providerId: w.project.forge,
    ref: 'forge/forge-mcp',
    version: '2026-09-20',
    type: 'mcp-tools',
  });
  await seedContractVersion(db, {
    providerId: w.project.plugin,
    ref: 'forge-plugin/driver-skill',
    version: '2026-09-28',
    type: 'json-schema',
  });
}

async function ok(res: Promise<{ status: number; json: Doc }>): Promise<Doc> {
  const { status, json } = await res;
  expect(status, JSON.stringify(json)).toBe(200);
  return json;
}

export async function formEcosystem(w: EcosystemWorld): Promise<void> {
  const send = sender(w);
  w.eco = (
    await ok(
      send('platform', 'POST', '/api/ecosystems', {
        baseRevision: null,
        document: ecosystemDoc(w.org.platform, 'forge-platform', 'FP'),
      }),
    )
  ).id;
  w.otherEco = (
    await ok(
      send('store', 'POST', '/api/ecosystems', {
        baseRevision: null,
        document: ecosystemDoc(w.org.store, 'storefronts', 'EPS'),
      }),
    )
  ).id;
  const sides: [ProjectKey, Who][] = [
    ['forge', 'platform'],
    ['plugin', 'plugin'],
    ['store', 'store'],
  ];
  for (const [key, admin] of sides) {
    const invited = await ok(
      send('platform', 'POST', `/api/ecosystems/${w.eco}/invitations`, { project: w.project[key] }),
    );
    w.membership[key] = invited.id;
    await ok(send(admin, 'POST', `/api/memberships/${invited.id}/accept`));
  }
}

export async function writeInterfaces(w: EcosystemWorld): Promise<void> {
  const send = sender(w);
  await recordVersions(w);
  const forge = `/api/projects/${w.project.forge}/interface`;
  await ok(
    send('platform', 'PUT', forge, {
      baseRevision: null,
      document: { ...forgeInterface(w), consumes: [] },
    }),
  );
  await ok(
    send('plugin', 'PUT', `/api/projects/${w.project.plugin}/interface`, {
      baseRevision: null,
      document: pluginInterface(w),
    }),
  );
  await ok(send('platform', 'PUT', forge, { baseRevision: 1, document: forgeInterface(w) }));
}
