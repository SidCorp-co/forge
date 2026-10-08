import { defineReportQuery, type ReportField } from '@forge/contracts/report-queries';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProjectAccess } from '../lib/authz.js';
import { clearReportQueriesForTest, registerReportQuery } from './registry.js';
import { runReportQuery } from './run.js';

const FIELD: ReportField = { name: 'a', type: 'number', label: 'A' };
const access = (role: ProjectAccess['role']) => ({ role, grants: [] }) as unknown as ProjectAccess;
const asker = (role: ProjectAccess['role']) => ({
  userId: 'u1',
  agency: 'human' as const,
  access: access(role),
});
const NOW = new Date('2026-10-08T09:00:00.000Z');

let reads = 0;
const register = (rows: Record<string, number | string | null>[], field = FIELD) =>
  registerReportQuery({
    descriptor: defineReportQuery({
      id: 'probe',
      version: 3,
      title: 'Probe',
      params: z.object({ k: z.string().optional() }),
      output: [FIELD],
      permission: 'project.read',
      egress: 'product',
      surfaces: ['rest'],
    }),
    reads: ['x/read.ts:readX'],
    run: async () => {
      reads += 1;
      return { fields: [field], rows };
    },
  });

beforeEach(() => {
  reads = 0;
});
afterEach(() => clearReportQueriesForTest());

describe('running a report query', () => {
  it('carries the provenance: query id, version, parsed params, project, actor and read time', async () => {
    register([{ a: 1 }]);
    const run = await runReportQuery({
      projectId: 'p1',
      queryId: 'probe',
      params: { k: 'v' },
      asker: asker('viewer'),
      now: NOW,
    });
    expect(run).toMatchObject({
      queryId: 'probe',
      version: 3,
      params: { k: 'v' },
      projectId: 'p1',
      actor: { kind: 'human', id: 'u1' },
      asOf: '2026-10-08T09:00:00.000Z',
      frame: { rows: [{ a: 1 }] },
    });
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a caller with no role on the project before reading anything', async () => {
    register([{ a: 1 }]);
    await expect(
      runReportQuery({ projectId: 'p1', queryId: 'probe', params: {}, asker: asker(null) }),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(reads).toBe(0);
  });

  it('refuses a frame whose fields differ from the output the query declared, naming both', async () => {
    register([{ b: 1 }], { name: 'b', type: 'number', label: 'B' });
    await expect(
      runReportQuery({ projectId: 'p1', queryId: 'probe', params: {}, asker: asker('viewer') }),
    ).rejects.toThrow(
      /report query "probe" returned fields \(b:number\) that differ from the output it declares \(a:number\)/,
    );
  });

  it('refuses a frame that breaks the frame contract, naming the row and field', async () => {
    register([{ a: 'text' }]);
    await expect(
      runReportQuery({ projectId: 'p1', queryId: 'probe', params: {}, asker: asker('viewer') }),
    ).rejects.toThrow(
      /report query "probe" returned a frame that breaks the frame contract: row 0 cell "a" is string, but the field is number/,
    );
  });
});
