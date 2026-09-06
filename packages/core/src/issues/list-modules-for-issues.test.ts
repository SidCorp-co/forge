import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ISS-594 — the grouping `search.ts` grafts onto a page of rows under `?withModules=1`.
 *
 * The whole value of this reader is in what SQL does not express: that the primary sorts first
 * within each issue, and that an issue with no module is absent from the map rather than present
 * with a wrong entry. The list cell renders `modules[0]`, so an issue whose secondary came back
 * first would display the wrong module as its primary and nothing downstream could tell.
 *
 * The `kind='module'` predicate itself is SQL and is proved against a real Postgres in
 * `tests/integration/module-taxonomy-e2e.test.ts`.
 */

type JoinRow = {
  issueId: string;
  labelId: string;
  name: string;
  color: string;
  isPrimary: boolean;
};

let joinRows: JoinRow[] = [];
let whereCalls = 0;

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => {
            whereCalls += 1;
            return Promise.resolve(joinRows);
          },
        }),
      }),
    }),
  },
}));

const { listModulesForIssues } = await import('./label-service.js');

const row = (issueId: string, labelId: string, name: string, isPrimary: boolean): JoinRow => ({
  issueId,
  labelId,
  name,
  color: '#1f6f4a',
  isPrimary,
});

beforeEach(() => {
  joinRows = [];
  whereCalls = 0;
});

describe('listModulesForIssues', () => {
  it('returns an empty map and queries nothing for an empty page', async () => {
    expect(await listModulesForIssues([])).toEqual(new Map());
    expect(whereCalls).toBe(0);
  });

  it('groups by issue id', async () => {
    joinRows = [row('i1', 'm1', 'core', true), row('i2', 'm2', 'web', true)];
    const out = await listModulesForIssues(['i1', 'i2']);
    expect(out.get('i1')?.map((m) => m.name)).toEqual(['core']);
    expect(out.get('i2')?.map((m) => m.name)).toEqual(['web']);
  });

  it('puts the primary first even when the row order does not', async () => {
    joinRows = [row('i1', 'm2', 'web', false), row('i1', 'm1', 'core', true)];
    const out = await listModulesForIssues(['i1']);
    expect(out.get('i1')?.map((m) => m.name)).toEqual(['core', 'web']);
  });

  it('keeps every secondary, in the order the query returned them', async () => {
    joinRows = [
      row('i1', 'm1', 'core', true),
      row('i1', 'm2', 'web', false),
      row('i1', 'm3', 'runner', false),
    ];
    expect(out(await listModulesForIssues(['i1']))).toEqual(['core', 'web', 'runner']);
  });

  it('handles an issue with secondaries and no primary', async () => {
    joinRows = [row('i1', 'm2', 'web', false)];
    const list = (await listModulesForIssues(['i1'])).get('i1');
    expect(list).toEqual([{ labelId: 'm2', name: 'web', color: '#1f6f4a', isPrimary: false }]);
  });

  it('omits an issue with no module rather than mapping it to a stand-in', async () => {
    joinRows = [row('i1', 'm1', 'core', true)];
    const map = await listModulesForIssues(['i1', 'i2']);
    expect(map.has('i2')).toBe(false);
  });

  it('carries the module colour through, since the cell renders it', async () => {
    joinRows = [{ ...row('i1', 'm1', 'core', true), color: '#8a3b52' }];
    expect((await listModulesForIssues(['i1'])).get('i1')?.[0]?.color).toBe('#8a3b52');
  });
});

function out(map: Map<string, { name: string }[]>): string[] {
  return (map.get('i1') ?? []).map((m) => m.name);
}
