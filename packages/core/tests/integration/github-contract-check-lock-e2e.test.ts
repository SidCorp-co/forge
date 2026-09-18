/**
 * The advisory lock, against a real Postgres.
 *
 * `check-run.test.ts` proves the SHAPE — that the lock is taken first and the
 * answer computed inside it — and it cannot prove more than that, because its
 * fake transaction serialises every callback whatever key the lock is given. A
 * namespace that varied per call would leave that file green and the production
 * race wide open. So the two properties the lock actually has are asserted here,
 * where `pg_advisory_xact_lock` is the real one:
 *
 * - two publishes for the SAME head do not overlap, so one run is created and
 *   the other updated rather than two created;
 * - two publishes for DIFFERENT heads DO overlap, so the lock is per head and
 *   not a global queue through which every project's publishes file one at a
 *   time.
 *
 * And a third property, which is about connections rather than locking: the
 * answer is computed on the transaction's own connection. Reading the pool from
 * inside would need a second connection while the first is held across HTTP, so
 * enough concurrent publishes would be the whole pool waiting on itself. The
 * different-head case proves it by finishing at all — both publishes hold a
 * transaction AND compute an answer at the same time.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const BINDING = randomUUID();

let harness: TestDatabase;
let publishContractCheck: typeof import('../../src/integrations/github/check-run.js').publishContractCheck;

interface Call {
  op: string;
  method: string;
  path: string;
  body?: unknown;
}

/**
 * A client whose `create` waits on a gate, so a second publish has every chance
 * to interleave before the first commits. Without the lock it takes it.
 */
function gatedClient(calls: Call[], runs: Map<string, number>, gate: () => Promise<void>): unknown {
  return {
    bindingId: BINDING,
    appId: '7',
    owner: 'SidCorp-co',
    repo: 'forge',
    fullName: 'SidCorp-co/forge',
    get: async () => {
      throw new Error('the publish path must not use the read door');
    },
    publish: async (call: Call) => {
      calls.push(call);
      if (call.op === 'lookup') {
        const head = call.path.split('/commits/')[1]?.split('/')[0] ?? '';
        const id = runs.get(head);
        return { check_runs: id === undefined ? [] : [{ id }] };
      }
      if (call.op === 'create') {
        await gate();
        const head = (call.body as { head_sha: string }).head_sha;
        const id = runs.size + 1;
        runs.set(head, id);
        return { id };
      }
      return { id: 0 };
    },
  };
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  ({ publishContractCheck } = await import('../../src/integrations/github/check-run.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe('two publishes for one head', () => {
  it('makes ONE check run, because the second cannot enter until the first commits', async () => {
    const calls: Call[] = [];
    const runs = new Map<string, number>();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gatedOnce = false;
    const gate = async () => {
      if (gatedOnce) return;
      gatedOnce = true;
      await held;
    };
    const client = gatedClient(calls, runs, gate) as Parameters<typeof publishContractCheck>[0];
    const issueId = randomUUID();

    const first = publishContractCheck(client, { issueId, headSha: H1 });
    // Long enough for an unserialised second publish to have looked and found
    // nothing — which is exactly the interleave the lock exists to prevent.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = publishContractCheck(client, { issueId, headSha: H1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    release?.();

    const outcomes = await Promise.all([first, second]);
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['created', 'updated']);
    expect(new Set(outcomes.map((o) => o.checkRunId)).size).toBe(1);
  });
});

describe('two publishes for different heads', () => {
  // cm:guard the lock is keyed on binding AND head, so unrelated heads overlap. A namespace-only key would make every publish on the deployment file through one queue, and this test is what tells the two apart — the same-head case above passes under either.
  it('overlap, so the key is per head rather than a queue for the whole deployment', async () => {
    const calls: Call[] = [];
    const runs = new Map<string, number>();
    let entered = 0;
    let bothIn: (() => void) | undefined;
    const both = new Promise<void>((resolve) => {
      bothIn = resolve;
    });
    const gate = async () => {
      entered += 1;
      if (entered >= 2) bothIn?.();
      // Neither publish may finish until BOTH are inside their own lock and
      // both have computed an answer — which is also two live transactions and
      // two answers at once, so nothing here can be waiting on a connection the
      // other is holding.
      await both;
    };
    const client = gatedClient(calls, runs, gate) as Parameters<typeof publishContractCheck>[0];
    const issueId = randomUUID();

    const outcomes = await Promise.all([
      publishContractCheck(client, { issueId, headSha: H1 }),
      publishContractCheck(client, { issueId, headSha: H2 }),
    ]);

    expect(entered).toBe(2);
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(2);
    expect(outcomes.map((o) => o.outcome)).toEqual(['created', 'created']);
  }, 20_000);
});

describe('as many concurrent publishes as the pool has connections', () => {
  // cm:guard TEN, because the pool is ten (`db/client.ts:buildDb`, `max: 10`). Each publish holds one connection for its transaction and is held here with that transaction open. If the answer's reads went to the POOL rather than to the transaction, all ten would be holding one connection and waiting for an eleventh that cannot exist — the whole pool waiting on itself until `idle_in_transaction_session_timeout` broke it. Finishing is the assertion.
  it('all finish, because each computes its answer on the connection it already holds', async () => {
    const calls: Call[] = [];
    const runs = new Map<string, number>();
    const width = 10;
    let entered = 0;
    let allIn: (() => void) | undefined;
    const all = new Promise<void>((resolve) => {
      allIn = resolve;
    });
    const gate = async () => {
      entered += 1;
      if (entered >= width) allIn?.();
      await all;
    };
    const client = gatedClient(calls, runs, gate) as Parameters<typeof publishContractCheck>[0];
    const issueId = randomUUID();

    const heads = Array.from({ length: width }, (_, i) =>
      i.toString(16).padStart(2, '0').repeat(20),
    );
    const outcomes = await Promise.all(
      heads.map((headSha) => publishContractCheck(client, { issueId, headSha })),
    );

    expect(entered).toBe(width);
    expect(outcomes.map((o) => o.outcome)).toEqual(Array(width).fill('created'));
  }, 25_000);
});
