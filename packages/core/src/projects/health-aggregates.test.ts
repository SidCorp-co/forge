import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every `db.select()` chain and every `db.execute()` resolves only when the test
 * releases it, so the moment all twelve reads are outstanding is observable — which
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

/** One request's reads: the ten rollups, the live-session count and the stuck-issue count. */
const READS = 12;
const PROJECT_IDS = ['22222222-2222-4222-8222-222222222222'];
const READER = '33333333-3333-4333-8333-333333333333';
/** The captured SQL as text; a column it embeds refers back to its table, so a repeat is skipped. */
function sqlText(captured: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(captured, (_key, value: unknown) => {
    if (value && typeof value === 'object') {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  });
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  gates.length = 0;
  executedSql.length = 0;
  started = 0;
});

describe('readHealthAggregates', () => {
  it('has more than one read outstanding at once, rather than awaiting them in sequence', async () => {
    const done = readHealthAggregates(PROJECT_IDS, READER);
    await tick();

    expect(healthReadLoad.inFlight).toBe(HEALTH_READ_CONCURRENCY);
    expect(started).toBe(HEALTH_READ_CONCURRENCY);
    expect(healthReadLoad.waiting).toBe(READS - HEALTH_READ_CONCURRENCY);

    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
      expect(healthReadLoad.inFlight).toBeLessThanOrEqual(HEALTH_READ_CONCURRENCY);
    }
    await done;
    expect(started).toBe(READS);
    expect(healthReadLoad.inFlight).toBe(0);
  });

  it('bounds two overlapping requests together, not one at a time', async () => {
    const first = readHealthAggregates(PROJECT_IDS, READER);
    const second = readHealthAggregates(PROJECT_IDS, READER);
    await tick();

    expect(healthReadLoad.inFlight).toBe(HEALTH_READ_CONCURRENCY);
    expect(started).toBe(HEALTH_READ_CONCURRENCY);
    expect(healthReadLoad.waiting).toBe(2 * READS - HEALTH_READ_CONCURRENCY);

    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
      expect(healthReadLoad.inFlight).toBeLessThanOrEqual(HEALTH_READ_CONCURRENCY);
      expect(started).toBeLessThanOrEqual(2 * READS);
    }
    await Promise.all([first, second]);
    expect(started).toBe(2 * READS);
  });

  it('computes the cycle figure in one pass, with no correlated subquery per row', async () => {
    const done = readHealthAggregates(PROJECT_IDS, READER);
    await tick();
    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
    }
    await done;

    const serialized = sqlText(executedSql);
    expect(serialized).toContain('DISTINCT ON (al.issue_id)');
    expect(serialized).toContain('LEFT JOIN work_start');
    expect(serialized).not.toContain('al2');
    expect(serialized).not.toContain('SELECT min(');
  });

  it('counts live sessions by the condition the pipeline surface lists them by', async () => {
    const done = readHealthAggregates(PROJECT_IDS, READER);
    await tick();
    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
    }
    await done;

    const serialized = sqlText(executedSql);
    expect(serialized).toContain('FROM agent_sessions s');
    expect(serialized).toContain("s.kind <> 'chat' AND s.status NOT IN (");
  });
});
