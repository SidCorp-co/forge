import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Array<{ id: string; email: string }> = [];
const wheres: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {} as never;
  chain['from'] = () => chain;
  chain['where'] = (clause: unknown) => {
    wheres.push(clause);
    return chain;
  };
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve([...rows]).then(resolve, reject);
  return chain;
}

vi.mock('../../db/client.js', () => ({ db: { select: () => makeChain() } }));

const { likePattern, normalizeEmail, proposeCandidates } = await import('./candidates.js');

beforeEach(() => {
  rows.length = 0;
  wheres.length = 0;
});

describe('normalizeEmail', () => {
  it('lowercases and trims an address, and refuses a non-address', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeEmail('alice')).toBeNull();
    expect(normalizeEmail('@example.com')).toBeNull();
    expect(normalizeEmail('alice@')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('proposeCandidates', () => {
  it('marks a whole-address match confirmable and a local-part match not', async () => {
    rows.push(
      { id: 'u-same', email: 'Alice@Example.com' },
      { id: 'u-near', email: 'alice@other.test' },
    );
    const out = await proposeCandidates('ALICE@example.com');
    expect(out).toEqual([
      { userId: 'u-same', email: 'alice@example.com', matchedOn: 'address', confirmable: true },
      { userId: 'u-near', email: 'alice@other.test', matchedOn: 'local-part', confirmable: false },
    ]);
  });

  it('returns a lone candidate as a candidate, never as a selection', async () => {
    rows.push({ id: 'u-same', email: 'alice@example.com' });
    const out = await proposeCandidates('alice@example.com');
    expect(out).toHaveLength(1);
    expect(out[0]?.confirmable).toBe(true);
  });

  it('asks nothing of the database for an address it cannot read', async () => {
    expect(await proposeCandidates('not-an-address')).toEqual([]);
    expect(wheres).toHaveLength(0);
  });

  it('escapes the LIKE metacharacters in a local part', () => {
    expect(likePattern('alice@example.com')).toBe('alice@%');
    expect(likePattern('%@example.com')).toBe('\\%@%');
    expect(likePattern('a_b@example.com')).toBe('a\\_b@%');
    expect(likePattern('a\\b@example.com')).toBe('a\\\\b@%');
  });

  it('keeps the human filter over BOTH match tiers, not just the LIKE one', async () => {
    rows.push({ id: 'u-same', email: 'alice@example.com' });
    await proposeCandidates('alice@example.com');
    const rendered = new PgDialect().sqlToQuery(wheres[0] as SQL).sql;
    const kindAt = rendered.indexOf('"kind"');
    const orAt = rendered.indexOf(' OR ');
    expect(kindAt).toBeGreaterThanOrEqual(0);
    expect(orAt).toBeGreaterThan(kindAt);
    expect(rendered.slice(rendered.indexOf('and', kindAt))).toMatch(/^and \(.* OR .*\)\)?$/);
  });

  it('drops a row whose stored address cannot be read', async () => {
    rows.push({ id: 'u-broken', email: 'not-an-address' });
    expect(await proposeCandidates('alice@example.com')).toEqual([]);
  });
});
