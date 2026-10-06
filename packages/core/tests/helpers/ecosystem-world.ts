import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { expect, type MockInstance, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { addProjectMember, createTestProject, createTestUser, seedOrg } from './factories.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
// biome-ignore lint/suspicious/noExplicitAny: documents are patched at arbitrary depth
export type Doc = Record<string, any>;
export type Who = 'platform' | 'plugin' | 'store' | 'viewer';
export type ProjectKey = 'forge' | 'internal' | 'plugin' | 'store';
export type Reply = { status: number; json: Doc };

/** The default-branch head every project's host reports in this world: no test box reaches a real host. */
export const JOIN_HEAD = '5d3a8f1c0e7b9a2d4c6e8f0a1b3c5d7e9f2a4b6c';

export interface EcosystemWorld {
  /** The stand-in for each project's host head read (`builder-head.ts:projectHead`). */
  head: MockInstance;
  app: Hono<AppVars>;
  token: Record<Who, string>;
  user: Record<Who, string>;
  org: Record<Exclude<Who, 'viewer'>, string>;
  project: Record<ProjectKey, string>;
  eco: string;
  otherEco: string;
  membership: Partial<Record<ProjectKey, string>>;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
let validators: Map<string, ReturnType<typeof ajv.compile>> | null = null;

/** Whether the JSON Schema core serves for `doc.$schema` accepts what an API answered. */
export async function emittedAccepts(doc: Doc): Promise<boolean> {
  if (!validators) {
    const { ecosystemJsonSchemas } = await import('../../src/ecosystem/json-schema.js');
    validators = new Map(
      Object.values(ecosystemJsonSchemas).map((s) => [(s as { $id: string }).$id, ajv.compile(s)]),
    );
  }
  const validate = validators.get(doc.$schema);
  if (!validate) throw new Error(`no emitted schema for ${doc.$schema}`);
  return validate(doc) as boolean;
}

const FIXTURES = new URL('../fixtures/ecosystem/', import.meta.url);
export const example = (file: string): Doc =>
  JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8'));

export function testEnv(): void {
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
}

/**
 * pg-boss over the test database with every outbox consumer working, as the server boots it: a
 * route that enqueues reaches a started queue, and an emitted event reaches its bell and its wake.
 */
export async function startQueue(): Promise<void> {
  const { startBoss } = await import('../../src/queue/boss.js');
  await startBoss();
  const { declareOutboxQueues, startOutboxWorker } = await import('../../src/outbox/index.js');
  await declareOutboxQueues();
  (await import('../../src/outbox-consumers.js')).registerOutboxConsumers();
  await startOutboxWorker();
}

/**
 * Waits until every outbox delivery due now has been worked, so a test reads the bell and the
 * wakes an act caused. A delivery still due after `ms` fails the test naming its queue.
 */
export async function settleOutbox(ms = 45_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const rows = (await db.execute(sql`
      SELECT name, state FROM pgboss_v12.job
      WHERE name LIKE 'outbox.%' AND name <> 'outbox.dead'
        AND (state = 'active' OR (state IN ('created', 'retry') AND start_after <= now()))
    `)) as unknown as { name: string; state: string }[];
    if (rows.length === 0) return;
    if (Date.now() > until) {
      throw new Error(
        `outbox: ${rows.length} delivery(ies) still due after ${ms}ms: ${rows.map((r) => `${r.name} (${r.state})`).join(', ')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Stops the outbox worker and the queue; the file's database goes with the harness. */
export async function closeWorld(): Promise<void> {
  const { stopOutboxWorker } = await import('../../src/outbox/index.js');
  await stopOutboxWorker();
  const { stopBoss } = await import('../../src/queue/boss.js');
  await stopBoss();
}

/** A project at a slug of the test's choosing: a contract is named `<provider slug>/<contract slug>`. */
export async function projectAt(createdBy: string, slug: string, orgId?: string): Promise<string> {
  const { id } = await createTestProject(createdBy, orgId ? { orgId } : {});
  await db.execute(sql`UPDATE projects SET slug = ${slug} WHERE id = ${id}`);
  return id;
}

export async function openWorld(): Promise<EcosystemWorld> {
  testEnv();

  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const people = {} as Record<Who, string>;
  const token = {} as Record<Who, string>;
  for (const who of ['platform', 'plugin', 'store', 'viewer'] as const) {
    people[who] = (await createTestUser({ verified: true })).id;
    token[who] = await signUserToken(people[who]);
  }
  const org = {
    platform: await seedOrg(people.platform),
    plugin: await seedOrg(people.plugin),
    store: await seedOrg(people.store),
  };
  const make = (slug: string, owner: keyof typeof org) =>
    projectAt(people[owner], slug, org[owner]);
  const project = {
    forge: await make('forge', 'platform'),
    internal: await make('forge-internal', 'platform'),
    plugin: await make('forge-plugin', 'plugin'),
    store: await make('store-x', 'store'),
  };
  await addProjectMember(project.plugin, people.viewer, 'viewer');

  const { app } = await import('../../src/index.js');
  await startQueue();
  (await import('../../src/integration-registry.js')).registerAllIntegrations();
  const { projectHead } = await import('../../src/ecosystem/builder-head.js');
  const head = vi.spyOn(projectHead, 'read').mockResolvedValue({
    ok: true,
    value: {
      sha: JOIN_HEAD,
      ref: 'refs/heads/main',
      readAt: new Date().toISOString(),
      via: 'source-host',
    },
  });
  return {
    head,
    app,
    token,
    user: people,
    org,
    project,
    eco: '',
    otherEco: '',
    membership: {},
  };
}

/** One request through the app in process, as `who` (a bearer from `tokens`), answered as status + JSON. */
export function requester(app: Hono<AppVars>, tokens: Record<string, string>) {
  return async (who: string, method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${tokens[who]}`,
        'content-type': 'application/json',
        'X-Forge-Lifecycle': '10',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Doc | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json: json as Doc };
  };
}

export function sender(w: EcosystemWorld) {
  return (who: Who, method: string, path: string, body?: unknown) =>
    requester(w.app, w.token)(who, method, path, body);
}

export const ok = (r: Reply, status = 200): Doc => {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json;
};

/** The refusals of a 422, each as `<code> <path>`. */
export const refusal = (r: Reply): string[] => {
  expect(r.status, JSON.stringify(r.json)).toBe(422);
  return (r.json.error?.refusals ?? []).map((x: Doc) => `${x.code} ${x.path}`);
};

export const refusalCodes = (r: Reply): string[] =>
  (r.json?.error?.refusals ?? []).map((x: Doc) => x.code) as string[];

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

export async function seedContractVersion(input: {
  providerId: string;
  ref: string;
  version: string;
  type?: string;
  elements?: string[] | null;
  previous?: string | null;
  classification?: 'initial' | 'non-breaking' | 'breaking' | 'unknown';
  /** Approved (as recorded before the gate) unless said otherwise; `proposed` waits on a decision. */
  approval?: 'approved' | 'proposed';
}): Promise<void> {
  const slug = input.ref.slice(input.ref.indexOf('/') + 1);
  const observedAt = new Date().toISOString();
  const classification = input.classification ?? 'initial';
  const document = {
    $schema: 'https://forge.sidcorp.co/schemas/contract-version-v1.json',
    version: 1,
    contract: input.ref,
    contractVersion: input.version,
    previous: input.previous ?? null,
    artifact: null,
    observedAt,
    diff: { tool: 'none', classification, changes: [] },
  };
  const elements = input.elements ?? null;
  const approved = (input.approval ?? 'approved') === 'approved';
  await db.execute(sql`
    INSERT INTO contract_versions
      (provider_project_id, contract_slug, version, recorded_at, contract_type, document, classification,
       approval, decided_as, decided_at, elements)
    VALUES (${input.providerId}, ${slug}, ${input.version}, ${observedAt}, ${input.type ?? 'openapi'},
            ${JSON.stringify(document)}::jsonb, ${classification},
            ${approved ? 'approved' : 'proposed'}, ${approved ? 'before-approval' : null},
            ${approved ? observedAt : null},
            ${
              elements === null
                ? null
                : sql`ARRAY[${sql.join(
                    elements.map((e) => sql`${e}`),
                    sql`, `,
                  )}]::text[]`
            })
  `);
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
  await seedContractVersion({
    providerId: w.project.forge,
    ref: 'forge/forge-api',
    version: '2026-09-20',
  });
  await seedContractVersion({
    providerId: w.project.forge,
    ref: 'forge/forge-mcp',
    version: '2026-09-20',
    type: 'mcp-tools',
  });
  await seedContractVersion({
    providerId: w.project.plugin,
    ref: 'forge-plugin/driver-skill',
    version: '2026-09-28',
    type: 'json-schema',
  });
}

export async function formEcosystem(w: EcosystemWorld): Promise<void> {
  const send = sender(w);
  w.eco = ok(
    await send('platform', 'POST', '/api/ecosystems', {
      baseRevision: null,
      document: ecosystemDoc(w.org.platform, 'forge-platform', 'FP'),
    }),
  ).id;
  w.otherEco = ok(
    await send('store', 'POST', '/api/ecosystems', {
      baseRevision: null,
      document: ecosystemDoc(w.org.store, 'storefronts', 'EPS'),
    }),
  ).id;
  const sides: [ProjectKey, Who][] = [
    ['forge', 'platform'],
    ['plugin', 'plugin'],
    ['store', 'store'],
  ];
  for (const [key, admin] of sides) {
    const invited = ok(
      await send('platform', 'POST', `/api/ecosystems/${w.eco}/invitations`, {
        project: w.project[key],
      }),
    );
    w.membership[key] = invited.id;
    ok(await send(admin, 'POST', `/api/memberships/${invited.id}/accept`));
  }
}

export async function writeInterfaces(w: EcosystemWorld): Promise<void> {
  const send = sender(w);
  await recordVersions(w);
  const forge = `/api/projects/${w.project.forge}/interface`;
  ok(
    await send('platform', 'PUT', forge, {
      baseRevision: null,
      document: { ...forgeInterface(w), consumes: [] },
    }),
  );
  ok(
    await send('plugin', 'PUT', `/api/projects/${w.project.plugin}/interface`, {
      baseRevision: null,
      document: pluginInterface(w),
    }),
  );
  ok(await send('platform', 'PUT', forge, { baseRevision: 1, document: forgeInterface(w) }));
}
