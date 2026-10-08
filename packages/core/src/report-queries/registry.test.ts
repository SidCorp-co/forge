import { defineReportQuery } from '@forge/contracts/report-queries';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ReportQueryAdapter } from './adapter.js';
import {
  clearReportQueriesForTest,
  getReportQuery,
  listReportQueries,
  registerReportQuery,
} from './registry.js';

const params = z.object({ n: z.number().int().optional() });

const query = (
  id: string,
  reads: readonly string[] = ['x/read.ts:readX'],
): ReportQueryAdapter<typeof params> => ({
  descriptor: defineReportQuery({
    id,
    version: 1,
    title: id,
    params,
    output: [{ name: 'a', type: 'number', label: 'A' }],
    permission: 'project.read',
    egress: 'product',
    surfaces: ['rest'],
  }),
  reads,
  run: async () => ({ fields: [{ name: 'a', type: 'number', label: 'A' }], rows: [] }),
});

afterEach(() => clearReportQueriesForTest());

describe('the report-queries registry', () => {
  it('refuses a read while empty, naming the boot call that was skipped', () => {
    expect(() => listReportQueries()).toThrow(/registerReportQueries\(\) was never called/);
    expect(() => getReportQuery('anything')).toThrow(/registerReportQueries\(\)/);
  });

  it('refuses a duplicate id, naming it', () => {
    registerReportQuery(query('one'));
    expect(() => registerReportQuery(query('one'))).toThrow(
      'report query "one" is already registered',
    );
  });

  it('refuses a query that declares no reads, naming it and the shape', () => {
    expect(() => registerReportQuery(query('bare', []))).toThrow(
      /report query "bare" declares no reads; name each read it is built over, as path\.ts:symbol/,
    );
  });

  it('refuses an unknown id, naming the ids that exist', () => {
    registerReportQuery(query('one'));
    registerReportQuery(query('two'));
    const err = (() => {
      try {
        getReportQuery('three');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({ status: 404 });
    expect((err as Error).message).toBe(
      'report query "three" is not registered; registered: one, two',
    );
  });

  it('parses params strictly: an unknown key is refused by name, a wrong type too', async () => {
    registerReportQuery(query('one'));
    const ctx = { projectId: 'p', now: new Date(), viewer: {} as never };
    const refusal = (raw: unknown) =>
      getReportQuery('one')
        .execute(ctx, raw)
        .then(
          () => null,
          (e: { status: number; cause: { code: string; details: string } }) => e,
        );
    expect(await refusal({ m: 1 })).toMatchObject({
      status: 400,
      cause: { code: 'REPORT_PARAMS_REFUSED' },
    });
    expect((await refusal({ m: 1 }))?.cause.details).toMatch(/report query "one": params refused/);
    expect((await refusal({ n: 'x' }))?.cause.details).toMatch(/n: /);
    await expect(getReportQuery('one').execute(ctx, { n: 2 })).resolves.toMatchObject({
      params: { n: 2 },
    });
  });
});
