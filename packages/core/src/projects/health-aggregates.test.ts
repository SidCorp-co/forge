import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every `db.select()` chain and every `db.execute()` resolves only when the test
 * releases it, so the moment all ten reads are outstanding is observable — which
 * is the whole point: a sequential handler never has two in flight, and a test
 * against an immediately-resolving mock cannot tell the two apart.
 */
const gates: Array<() => void> = [];
const executedSql: unknown[] = [];
let started = 0;

function pending(): PromiseLike<unknown> {
  started += 1;
  return {
    then(resolve, reject) {
      return new Promise<unknown>((r) => gates.push(() => r([]))).then(resolve, reject);
    },
  } as PromiseLike<unknown>;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'groupBy', 'limit']) {
    chain[m] = () => chain;
  }
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    pending().then(resolve, reject);
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeChain(),
    execute: (query: unknown) => {
      executedSql.push(query);
      return pending();
    },
  },
}));

const { readHealthAggregates, healthReadLoad, HEALTH_READ_CONCURRENCY } = await import(
  './health-aggregates.js'
);

const PROJECT_IDS = ['22222222-2222-4222-8222-222222222222'];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  gates.length = 0;
  executedSql.length = 0;
  started = 0;
});

describe('readHealthAggregates', () => {
  // cm:guard this asserts the PEAK while the reads are outstanding. The route's own test resolves its mock immediately, so it reads the same either way — this is the case that goes red if the ten reads go back to being awaited in sequence (ISS-1018).
  it('has more than one read outstanding at once, rather than awaiting them in sequence', async () => {
    const done = readHealthAggregates(PROJECT_IDS);
    await tick();

    expect(healthReadLoad.inFlight).toBe(HEALTH_READ_CONCURRENCY);
    expect(started).toBe(HEALTH_READ_CONCURRENCY);
    expect(healthReadLoad.waiting).toBe(10 - HEALTH_READ_CONCURRENCY);

    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
      expect(healthReadLoad.inFlight).toBeLessThanOrEqual(HEALTH_READ_CONCURRENCY);
    }
    await done;
    expect(started).toBe(10);
    expect(healthReadLoad.inFlight).toBe(0);
  });

  // cm:guard the pool is `max: 10` in db/client.ts, so two overlapping requests must still not ask for more than four connections BETWEEN them — which is what a module-scoped limiter buys and a per-request one does not.
  it('bounds two overlapping requests together, not one at a time', async () => {
    const first = readHealthAggregates(PROJECT_IDS);
    const second = readHealthAggregates(PROJECT_IDS);
    await tick();

    expect(healthReadLoad.inFlight).toBe(HEALTH_READ_CONCURRENCY);
    expect(started).toBe(HEALTH_READ_CONCURRENCY);
    expect(healthReadLoad.waiting).toBe(20 - HEALTH_READ_CONCURRENCY);

    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
      expect(healthReadLoad.inFlight).toBeLessThanOrEqual(HEALTH_READ_CONCURRENCY);
      expect(started).toBeLessThanOrEqual(20);
    }
    await Promise.all([first, second]);
    expect(started).toBe(20);
  });

  // cm:guard the shape, not the figure: the correlated `min()` this replaced ran once per qualifying activity_log row, and the figures themselves are proved against a real Postgres in tests/integration/health-routes.test.ts.
  it('computes the cycle figure in one pass, with no correlated subquery per row', async () => {
    const done = readHealthAggregates(PROJECT_IDS);
    await tick();
    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
    }
    await done;

    const serialized = JSON.stringify(executedSql);
    expect(serialized).toContain('DISTINCT ON (al.issue_id)');
    expect(serialized).toContain('LEFT JOIN work_start');
    expect(serialized).not.toContain('al2');
    expect(serialized).not.toContain('SELECT min(');
  });
});
