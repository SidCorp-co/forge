// ISS-279 / FB-91: feedback about Autoflow's MCP tool `save_backend_workflow` had no target but a
// Screen. An item is now about a route or tool the project serves, named and refused like the other
// targets: the served set is the current version of each openapi and mcp-tools contract the project
// provides, never free text.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  refusedByDb,
  requester,
  seedContractVersion,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let serving = '';
let servingNothing = '';
let other = '';
let otherSlug = '';
let ownerId = '';

const at = (project: string, path: string) => `/api/projects/${project}${path}`;

function refusal(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBe(422);
  const [first] = r.json.error?.refusals ?? [];
  expect(first, JSON.stringify(r.json)).toBeDefined();
  return { code: first.code, path: first.path, detail: first.detail };
}

const file = (project: string, body: Doc) =>
  say('owner', 'POST', at(project, '/feedback'), { kind: 'bug', title: 'A tool', ...body });

const read = async (fb: string): Promise<Doc> =>
  ok(await say('owner', 'GET', at(serving, `/feedback/${fb}`))).feedback;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  serving = (await createTestProject(ownerId)).id;
  servingNothing = (await createTestProject(ownerId)).id;
  const o = await createTestProject(ownerId);
  other = o.id;
  otherSlug = o.slug;
  say = requester(app, { owner: await signUserToken(ownerId) });
  await seedContractVersion({
    providerId: serving,
    ref: 'p/shop-tools',
    version: '1.0.0',
    type: 'mcp-tools',
    elements: [
      'save_backend_workflow',
      'save_backend_workflow/properties/graph',
      'list_backend_routes',
    ],
  });
  await seedContractVersion({
    providerId: serving,
    ref: 'p/shop-tools',
    version: '1.1.0',
    type: 'mcp-tools',
    previous: '1.0.0',
    classification: 'non-breaking',
    approval: 'proposed',
    elements: ['save_backend_workflow', 'list_backend_routes', 'brand_new_tool'],
  });
  await seedContractVersion({
    providerId: serving,
    ref: 'p/admin-tools',
    version: '2.0.0',
    type: 'mcp-tools',
    elements: ['list_backend_routes'],
  });
  await seedContractVersion({
    providerId: serving,
    ref: 'p/shop-api',
    version: '3.0.0',
    type: 'openapi',
    elements: ['GET /pets', 'POST /pets'],
  });
  await seedContractVersion({
    providerId: serving,
    ref: 'p/shop-events',
    version: '1.0.0',
    type: 'json-schema',
    elements: ['#/$defs/Order'],
  });
  await seedContractVersion({
    providerId: other,
    ref: 'o/orders-api',
    version: '1.0.0',
    type: 'openapi',
    elements: ['GET /orders'],
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an item is filed about a route or tool the project serves', () => {
  it('takes the tool FB-91 named, by its bare name, keyed by the contract that serves it', async () => {
    const made = ok(await file(serving, { endpoint: 'save_backend_workflow' }), 201).feedback;
    expect(made.target).toEqual({
      type: 'endpoint',
      key: 'shop-tools:save_backend_workflow',
      title: 'shop-tools 1.0.0',
    });
    expect(made.whereSeen).toBeNull();
  });

  it('takes an openapi route as METHOD /path', async () => {
    const made = ok(await file(serving, { endpoint: 'GET /pets' }), 201).feedback;
    expect(made.target).toMatchObject({ type: 'endpoint', key: 'shop-api:GET /pets' });
  });

  it('takes a name qualified by its contract, which is how a name two contracts serve is told apart', async () => {
    const twice = refusal(await file(serving, { endpoint: 'list_backend_routes' }));
    expect(twice).toMatchObject({ code: 'FEEDBACK_TARGET_NOT_ONE', path: '/endpoint' });
    expect(twice.detail).toContain('admin-tools:list_backend_routes');
    expect(twice.detail).toContain('shop-tools:list_backend_routes');
    const made = ok(await file(serving, { endpoint: 'admin-tools:list_backend_routes' }), 201);
    expect(made.feedback.target.key).toBe('admin-tools:list_backend_routes');
  });
});

describe('a name the project does not serve is refused by name', () => {
  it('refuses an unserved name, naming what the project does serve', async () => {
    const r = refusal(await file(serving, { endpoint: 'save_backend_flow' }));
    expect(r).toMatchObject({ code: 'FEEDBACK_TARGET_UNKNOWN', path: '/endpoint' });
    expect(r.detail).toContain('save_backend_flow');
    expect(r.detail).toContain('shop-tools:save_backend_workflow');
    expect(r.detail).toContain('shop-api:GET /pets');
  });

  it('serves a tool, never one of its input properties', async () => {
    const r = refusal(await file(serving, { endpoint: 'save_backend_workflow/properties/graph' }));
    expect(r.code).toBe('FEEDBACK_TARGET_UNKNOWN');
  });

  it('serves the current version only, never one still proposed', async () => {
    const r = refusal(await file(serving, { endpoint: 'brand_new_tool' }));
    expect(r.code).toBe('FEEDBACK_TARGET_UNKNOWN');
  });

  it('serves neither a json-schema contract nor another project’s contract', async () => {
    expect(refusal(await file(serving, { endpoint: '#/$defs/Order' })).code).toBe(
      'FEEDBACK_TARGET_UNKNOWN',
    );
    const foreign = refusal(await file(serving, { endpoint: 'orders-api:GET /orders' }));
    expect(foreign.code).toBe('FEEDBACK_TARGET_UNKNOWN');
    expect(foreign.detail).not.toContain(otherSlug);
  });

  it('says so on a project that provides no route or tool, and how to declare one', async () => {
    const r = refusal(await file(servingNothing, { endpoint: 'save_backend_workflow' }));
    expect(r).toMatchObject({ code: 'FEEDBACK_TARGET_UNKNOWN', path: '/endpoint' });
    expect(r.detail).toMatch(/provides no openapi or mcp-tools contract/);
    expect(r.detail).toContain('interface');
  });

  it('counts an endpoint as a target: beside a screen it is two', async () => {
    const r = refusal(await file(serving, { endpoint: 'GET /pets', screen: 'The board' }));
    expect(r.code).toBe('FEEDBACK_TARGET_NOT_ONE');
  });
});

describe('an item filed as a Screen moves to the tool it was about', () => {
  it('retargets to the endpoint and back, and records both moves', async () => {
    const fb = ok(await file(serving, { screen: 'MCP tool save_backend_workflow' }), 201).feedback
      .key as string;
    const moved = ok(
      await say('owner', 'POST', at(serving, `/feedback/${fb}/retarget`), {
        endpoint: 'save_backend_workflow',
      }),
    ).feedback;
    expect(moved.target).toMatchObject({
      type: 'endpoint',
      key: 'shop-tools:save_backend_workflow',
    });
    expect(moved.decisions.at(-1)).toMatchObject({
      decision: 'retargeted',
      carrier: 'shop-tools:save_backend_workflow',
      reason:
        'from screen “MCP tool save_backend_workflow” to endpoint shop-tools:save_backend_workflow',
    });
    const same = refusal(
      await say('owner', 'POST', at(serving, `/feedback/${fb}/retarget`), {
        endpoint: 'shop-tools:save_backend_workflow',
      }),
    );
    expect(same.code).toBe('FEEDBACK_TARGET_UNCHANGED');
    const back = ok(
      await say('owner', 'POST', at(serving, `/feedback/${fb}/retarget`), { screen: 'The board' }),
    ).feedback;
    expect(back.target).toMatchObject({ type: 'screen', key: 'The board' });
    expect((await read(fb)).decisions.filter((d: Doc) => d.decision === 'retargeted')).toHaveLength(
      2,
    );
  });
});

describe('the served set the picker offers', () => {
  it('lists the routes and tools of the current versions, and nothing for a project serving none', async () => {
    const served = ok(await say('owner', 'GET', at(serving, '/feedback/endpoints'))).endpoints;
    expect(served).toContainEqual({
      key: 'shop-tools:save_backend_workflow',
      contract: 'shop-tools',
      version: '1.0.0',
      type: 'mcp-tools',
      element: 'save_backend_workflow',
    });
    expect(served.map((s: Doc) => s.key)).toEqual([
      'admin-tools:list_backend_routes',
      'shop-api:GET /pets',
      'shop-api:POST /pets',
      'shop-tools:list_backend_routes',
      'shop-tools:save_backend_workflow',
    ]);
    expect(
      ok(await say('owner', 'GET', at(servingNothing, '/feedback/endpoints'))).endpoints,
    ).toEqual([]);
  });
});

describe('the database holds the arc', () => {
  const insert = (columns: Doc) => {
    const c = {
      requirement_id: null,
      where_seen: null,
      endpoint_contract_slug: null,
      endpoint_contract_version: null,
      endpoint_element: null,
      ...columns,
    };
    return rows(sql`
      INSERT INTO feedback (project_id, fb_seq, kind, title, reported_by, reporter_agency, requirement_id,
                            where_seen, endpoint_contract_slug, endpoint_contract_version, endpoint_element)
      VALUES (${serving}, 9000 + floor(random() * 1000)::int, 'bug', 'planted', ${ownerId}, 'human',
              ${c.requirement_id}::uuid, ${c.where_seen}, ${c.endpoint_contract_slug},
              ${c.endpoint_contract_version}, ${c.endpoint_element})`);
  };
  const endpoint = {
    endpoint_contract_slug: 'shop-tools',
    endpoint_contract_version: '1.0.0',
    endpoint_element: 'save_backend_workflow',
  };

  it('refuses an endpoint beside another target', async () => {
    // a CHECK is read before a foreign key, so the made-up requirement is never looked up
    await refusedByDb(insert({ ...endpoint, requirement_id: randomUUID() }), /feedback_arc_chk/);
  });

  it('refuses no target at all, and part of an endpoint', async () => {
    await refusedByDb(insert({}), /feedback_arc_chk/);
    await refusedByDb(
      insert({ endpoint_element: 'save_backend_workflow' }),
      /feedback_endpoint_target_chk/,
    );
  });

  it('refuses an endpoint naming a contract version the project never recorded', async () => {
    await refusedByDb(
      insert({ ...endpoint, endpoint_contract_version: '9.9.9' }),
      /feedback_endpoint_contract_version_fk/,
    );
  });

  it('takes a whole endpoint alone', async () => {
    await insert(endpoint);
  });
});
