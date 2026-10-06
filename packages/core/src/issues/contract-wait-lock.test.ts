import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./ports.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  settlingContractVersion: async () => null,
}));

const { insertContractWaitIn, lockContractsIn } = await import('./contract-waits.js');

describe('a wait is written under its contract lock', () => {
  it('takes the lock an approval settles waits under before it reads what settles it', async () => {
    const order: string[] = [];
    const tx = {
      execute: async (q: SQL) => {
        const { sql, params } = new PgDialect().sqlToQuery(q);
        order.push(`${sql} ${JSON.stringify(params)}`);
      },
      insert: () => ({
        values: () => ({
          returning: async () => {
            order.push('insert');
            return [{ id: 'w1' }];
          },
        }),
      }),
    };
    await insertContractWaitIn(tx as never, {
      projectId: 'p1',
      issueId: 'i1',
      providerProjectId: 'prov-1',
      contractSlug: 'admin-rest-v1',
      minVersion: '3.1.0',
      reason: null,
      createdBy: 'u1',
      dueAt: null,
    });
    expect(order[0]).toContain('pg_advisory_xact_lock');
    expect(order[0]).toContain('contract:prov-1/admin-rest-v1');
    expect(order[1]).toBe('insert');
  });

  it('takes several contracts in key order, once each, whatever order they are named in', async () => {
    const keys: unknown[] = [];
    const tx = {
      execute: async (q: SQL) => {
        keys.push(new PgDialect().sqlToQuery(q).params[1]);
      },
    };
    await lockContractsIn(tx as never, [
      { providerProjectId: 'prov-2', contractSlug: 'b' },
      { providerProjectId: 'prov-1', contractSlug: 'a' },
      { providerProjectId: 'prov-2', contractSlug: 'b' },
    ]);
    expect(keys).toEqual(['contract:prov-1/a', 'contract:prov-2/b']);
  });
});
