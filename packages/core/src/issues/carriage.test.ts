// A mark says an artifact is carried by another issue only explicitly, and only of an issue that
// can still ship it: another issue of the same project that has not closed or dropped.

import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; projectId: string; seq: number; status: string }>,
}));

vi.mock('../db/client.js', () => {
  const dialect = new PgDialect();
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => ({
            limit: async () => {
              const { params } = dialect.sqlToQuery(cond as never);
              return state.rows.filter(
                (r) =>
                  params.includes(r.id) || (params.includes(r.projectId) && params.includes(r.seq)),
              );
            },
          }),
        }),
      }),
    },
  };
});
vi.mock('./issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => 'HOP',
  heldIssuePrefixes: async () => ['HOP'],
}));

const { resolveCarriage } = await import('./carriage.js');

const OTHER = '00000000-0000-4000-8000-0000000000e1';
const access = (carriedBy: string, surface: 'logic' | 'design' = 'logic') => ({
  surface,
  ref: 'autoflow hop draft workflow 193 @999dcf6d: access block',
  change: 'changed' as const,
  carriedBy,
});
const mark = (artifact: ReturnType<typeof access>) =>
  resolveCarriage({ issueId: 'id-54', projectId: 'hop', artifacts: [artifact] });

beforeEach(() => {
  state.rows = [
    { id: 'id-54', projectId: 'hop', seq: 54, status: 'in_progress' },
    { id: 'id-110', projectId: 'hop', seq: 110, status: 'in_progress' },
    { id: 'id-90', projectId: 'hop', seq: 90, status: 'closed' },
    { id: OTHER, projectId: 'epod', seq: 7, status: 'open' },
  ];
});

describe('resolveCarriage', () => {
  it("stores the carrier as this project's key, however it was named", async () => {
    for (const named of ['ISS-110', 'HOP-110', '110']) {
      const out = await mark(access(named));
      expect(out).toEqual({ ok: true, artifacts: [access('HOP-110')] });
    }
  });

  it('refuses each carrier that cannot ship it, by name', async () => {
    expect(await mark(access('HOP-54'))).toMatchObject({
      ok: false,
      code: 'ARTIFACT_CARRIER_SELF',
      index: 0,
    });
    expect(await mark(access('HOP-90'))).toMatchObject({
      ok: false,
      code: 'ARTIFACT_CARRIER_SHIPPED',
      detail: expect.stringContaining('carried by HOP-90, which is `closed`'),
    });
    expect(await mark(access('HOP-404'))).toMatchObject({
      ok: false,
      code: 'ARTIFACT_CARRIER_UNKNOWN',
      detail: expect.stringContaining('`HOP-404` names no issue in this project'),
    });
    expect(await mark(access('EPOD-7'))).toMatchObject({
      ok: false,
      code: 'ARTIFACT_CARRIER_UNKNOWN',
      detail: expect.stringContaining('`EPOD-7` is not a key of this project'),
    });
    expect(await mark(access(OTHER))).toMatchObject({
      ok: false,
      code: 'ARTIFACT_CARRIER_UNKNOWN',
      detail: expect.stringContaining('is an issue of another project'),
    });
    expect(await mark(access('HOP-110', 'design'))).toMatchObject({
      ok: false,
      code: 'ARTIFACT_CARRIER_DESIGN',
    });
  });
});
