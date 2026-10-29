import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { OPEN_QUERY_READS, type OpenQuery } from './open-queries.js';
import { buildApiContract } from './openapi.js';
import { CONTRACTS_DIR } from './routes.js';

const INFO = { title: 'probe', version: '0.0.0' };
const answer = () => new Response('{}');

const REDIRECT: OpenQuery = {
  reason: 'a provider redirects here and chooses the keys',
  trades: 'a key it does not take is dropped',
  endsWhen: 'it is no longer a redirect target',
};

type Operation = Record<string, unknown>;

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
      .get('/closed', noQuery, answer)
      .get('/filtered', zValidator('query', z.object({ status: z.string().optional() })), answer)
      .get('/open', answer)
      .post('/write', answer);
    const { refusals } = buildApiContract(app.routes, INFO, {});
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^GET \/open: a read whose query is not closed/);
    expect(refusals[0]).toContain('open-queries.ts');
  });

  it('refuses a z.looseObject query not on the allowlist, which the contract cannot mark closed', () => {
    const app = new Hono().get(
      '/loose',
      zValidator('query', z.looseObject({ code: z.string().optional() })),
      answer,
    );
    const { refusals } = buildApiContract(app.routes, INFO, {});
    expect(refusals).toEqual([expect.stringMatching(/^GET \/loose: a read whose query/)]);
  });

  it('describes an allowlisted read as open with its reason, and refuses nothing', () => {
    const app = new Hono().get(
      '/callback',
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
    const app = new Hono().get('/closed', noQuery, answer);
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
