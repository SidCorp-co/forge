/**
 * @direct-test-of packages/core/src/api-contract/declared-answers.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { declaredResponse } from '../middleware/declared-response.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import {
  requireDeclared,
  requiresNoPermission,
  requiresOnParam,
  requiresOnResolved,
} from '../permissions/declared.js';
import { OPEN_QUERY_READS, type OpenQuery } from './open-queries.js';
import { buildApiContract, UNDECLARED_RESPONSE } from './openapi.js';
import { CONTRACTS_DIR } from './routes.js';

const INFO = { title: 'probe', version: '0.0.0' };
const answer = () => new Response('{}');

const REDIRECT: OpenQuery = {
  reason: 'a provider redirects here and chooses the keys',
  trades: 'a key it does not take is dropped',
  endsWhen: 'it is no longer a redirect target',
};

type Operation = Record<string, unknown>;

/** A probe route's declaration, for the tests not about the permission rule. */
const NONE = requiresNoPermission('a probe route this test is not about');

function operationsOf(document: Record<string, unknown>): [string, Operation][] {
  const paths = document.paths as Record<string, Record<string, Operation>>;
  return Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]): [string, Operation] => [
      `${method.toUpperCase()} ${path}`,
      op,
    ]),
  );
}

describe('a read closes its query, or is a named amnesty (ISS-753)', () => {
  it('refuses a GET whose query is open, naming it, and passes the closed ones', () => {
    const app = new Hono()
      .get('/closed', NONE, noQuery, answer)
      .get(
        '/filtered',
        NONE,
        zValidator('query', z.object({ status: z.string().optional() })),
        answer,
      )
      .get('/open', NONE, answer)
      .post('/write', NONE, answer);
    const { refusals } = buildApiContract(app.routes, INFO, {});
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^GET \/open: a read whose query is not closed/);
    expect(refusals[0]).toContain('open-queries.ts');
  });

  it('refuses a z.looseObject query not on the allowlist, which the contract cannot mark closed', () => {
    const app = new Hono().get(
      '/loose',
      NONE,
      zValidator('query', z.looseObject({ code: z.string().optional() })),
      answer,
    );
    const { refusals } = buildApiContract(app.routes, INFO, {});
    expect(refusals).toEqual([expect.stringMatching(/^GET \/loose: a read whose query/)]);
  });

  it('describes an allowlisted read as open with its reason, and refuses nothing', () => {
    const app = new Hono().get(
      '/callback',
      NONE,
      zValidator('query', z.looseObject({ code: z.string().optional() })),
      answer,
    );
    const { refusals, document } = buildApiContract(app.routes, INFO, {
      'GET /callback': REDIRECT,
    });
    expect(refusals).toEqual([]);
    const [, op] = operationsOf(document).find(([name]) => name === 'GET /callback') ?? [];
    expect(op?.['x-forge-query-open']).toBe(REDIRECT.reason);
    expect(op?.['x-forge-query-closed']).toBeUndefined();
  });

  it('refuses an allowlist entry for a read that is closed, and one no route mounts', () => {
    const app = new Hono().get('/closed', NONE, noQuery, answer);
    const { refusals } = buildApiContract(app.routes, INFO, {
      'GET /closed': REDIRECT,
      'GET /gone': REDIRECT,
    });
    expect(refusals).toEqual([
      expect.stringMatching(/^GET \/closed: an open-query amnesty .* whose query is closed/),
      expect.stringMatching(/^GET \/gone: an open-query amnesty .* no route mounts/),
    ]);
  });
});

describe('the allowlist prices each amnesty', () => {
  for (const [name, entry] of Object.entries(OPEN_QUERY_READS)) {
    it(`${name} names its reason, what it trades and when it ends`, () => {
      expect(name).toMatch(/^GET \//);
      for (const field of ['reason', 'trades', 'endsWhen'] as const) {
        expect(entry[field].trim().length, field).toBeGreaterThan(20);
      }
    });
  }
});

describe('the committed API contract', () => {
  const document = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, 'forge-api.openapi.json'), 'utf8'),
  ) as Record<string, unknown>;
  const reads = operationsOf(document).filter(([name]) => name.startsWith('GET '));

  it('marks every read closed, or open with the reason the allowlist gives', () => {
    const unmarked = reads
      .filter(([, op]) => op['x-forge-query-closed'] !== true)
      .filter(([, op]) => typeof op['x-forge-query-open'] !== 'string')
      .map(([name]) => name);
    expect(unmarked).toEqual([]);
    const open = reads.filter(([, op]) => op['x-forge-query-open'] !== undefined);
    expect(open.length).toBe(Object.keys(OPEN_QUERY_READS).length);
  });
});

describe('every route declares its permission where it is mounted (REQ-12 BC-20, ISS-824)', () => {
  const app = new Hono()
    .get('/p/:projectId/debts', noQuery, requiresOnParam('project.read'), answer)
    .post('/i/:id/impact', requiresOnResolved('project.write', "the issue's project"), answer)
    .get('/health', noQuery, requiresNoPermission('a liveness probe reads no project'), answer)
    .post('/bare', answer);

  it('names it on the operation, and refuses a route that declares none, with no exception', () => {
    const { document, refusals } = buildApiContract(app.routes, INFO, {});
    const ops = new Map(operationsOf(document));
    expect(ops.get('GET /p/{projectId}/debts')?.['x-forge-permission']).toEqual({
      permission: 'project.read',
      on: { param: 'projectId' },
    });
    expect(ops.get('POST /i/{id}/impact')?.['x-forge-permission']).toEqual({
      permission: 'project.write',
      on: { resolved: "the issue's project" },
    });
    expect(ops.get('GET /health')?.['x-forge-permission']).toEqual({
      none: 'a liveness probe reads no project',
    });
    expect(refusals).toEqual([expect.stringMatching(/^POST \/bare: declares no permission/)]);
  });

  it("checks a resolved route's declared permission, and throws naming a route that declared none", async () => {
    const access = { projectId: 'p1', role: 'viewer' as const, grants: [] };
    const checked = new Hono()
      .post('/declared', requiresOnResolved('project.write', 'the body'), (c) => {
        requireDeclared(access as never);
        return c.text('ok');
      })
      .post('/undeclared', (c) => {
        requireDeclared(access as never);
        return c.text('ok');
      })
      .onError((err, c) => c.text(err.message, 500));
    const refused = await checked.request('/declared', { method: 'POST' });
    expect(await refused.text()).toContain('project.write');
    const wiring = await checked.request('/undeclared', { method: 'POST' });
    expect(await wiring.text()).toContain('declares no permission');
  });
});

describe('the committed API contract names a permission on every operation', () => {
  const document = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, 'forge-api.openapi.json'), 'utf8'),
  ) as Record<string, unknown>;

  it('carries x-forge-permission on every operation, with none left undeclared', () => {
    const without = operationsOf(document)
      .filter(([, op]) => op['x-forge-permission'] === undefined)
      .map(([name]) => name);
    expect(without).toEqual([]);
  });
});

describe('a declared answer is written at its own route and nowhere else (ISS-1412)', () => {
  const body = z.strictObject({ reason: z.string().nullable() });
  const door = (method = 'GET') =>
    declaredResponse({
      method,
      status: 200,
      under: 'a probe key',
      description: 'the probe body.',
      schema: body,
    });

  it('writes it under the status of exactly its path and method, beside the undeclared default', () => {
    const app = new Hono()
      .use('/items/:ref', door())
      .get('/items/:ref', NONE, noQuery, answer)
      .post('/items/:ref', NONE, answer)
      .get('/items/keys', NONE, noQuery, answer);
    const { document, refusals } = buildApiContract(app.routes, INFO, {});
    expect(refusals).toEqual([]);
    const ops = Object.fromEntries(operationsOf(document));
    const responses = ops['GET /items/{ref}']?.responses as Record<string, Operation> | undefined;
    const declared = responses?.['200'];
    const content = declared?.content as
      | Record<string, { schema: { anyOf: Operation[] } }>
      | undefined;
    const anyOf = content?.['application/json']?.schema.anyOf;
    expect(anyOf?.[0]).toMatchObject({ title: 'Under a probe key', additionalProperties: false });
    expect(anyOf?.[1]).toEqual({
      title: 'Under any other credential',
      description: UNDECLARED_RESPONSE,
    });
    expect(declared?.description).toMatch(/^Under a probe key: the probe body\. Under any other/);
    for (const other of ['POST /items/{ref}', 'GET /items/keys']) {
      expect(Object.keys(ops[other]?.responses as Operation), other).not.toContain('200');
    }
  });

  it('refuses an answer declared for a method its path does not mount', () => {
    const app = new Hono().use('/items/:ref', door('PUT')).get('/items/:ref', NONE, answer);
    const { refusals } = buildApiContract(app.routes, INFO, {});
    expect(refusals).toContain(
      'PUT /items/:ref: a declared 200 answer for a route that is not mounted',
    );
  });
});
