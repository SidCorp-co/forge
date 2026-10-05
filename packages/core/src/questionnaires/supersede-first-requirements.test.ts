import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

const wheres: SQL[] = [];
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../lifecycle/index.js', () => ({
  transition: async (_tx: unknown, _machine: unknown, args: { where: SQL }) => {
    wheres.push(args.where);
    return { rows: wheres.length === 1 ? [{ id: 'b1' }] : [] };
  },
}));

const { supersedeOpenIn } = await import('./service.js');

describe('project-onboarding may-start: a re-analysis supersedes the open batches', () => {
  it('reaches the first-requirements batch of the onboarding as well as its own rounds', async () => {
    const ids = await supersedeOpenIn({} as never, 'onb-1', 'superseded by re-analysis');
    expect(ids).toEqual(['b1']);
    const { sql, params } = new PgDialect().sqlToQuery(wheres[0] as SQL);
    expect(sql).toContain('"onboarding_id"');
    expect(sql).toContain('"first_requirements_of"');
    expect(params.filter((p) => p === 'onb-1')).toHaveLength(2);
  });
});
