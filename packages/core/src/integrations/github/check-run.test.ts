/**
 * Putting one check run on one head, and the two races that make it two.
 *
 * The Checks API has no upsert: a POST under a name already on the head makes a
 * SECOND run rather than replacing the first. So everything here is about the
 * lookup that decides which write happens, and about the lock that stops two
 * publishes both deciding "create".
 *
 * The transaction is faked with a QUEUE rather than a no-op, and that is the
 * whole design of this file: `pg_advisory_xact_lock` serialises, so a fake that
 * let both callbacks interleave would prove the opposite of the production
 * behaviour and pass either way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const execute = vi.fn(async () => undefined);

/** One transaction at a time, which is what the advisory lock buys in production. */
let tail: Promise<unknown> = Promise.resolve();
const transaction = vi.fn(<T>(fn: (tx: { execute: typeof execute }) => Promise<T>): Promise<T> => {
  const run = tail.then(() => fn({ execute }));
  tail = run.catch(() => undefined);
  return run;
});
vi.mock('../../db/client.js', () => ({ db: { transaction } }));

const answerFor = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('./contract-answer.js', () => ({
  CONTRACT_SOURCE: 'the declared status entry criteria',
  contractAnswerForIssue: (...args: unknown[]) => answerFor(...args),
}));

const { CHECK_RUN_NAME } = await import('./check-run-body.js');
const { publishContractCheck } = await import('./check-run.js');
type Client = Parameters<typeof publishContractCheck>[0];

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const HEAD = 'a'.repeat(40);

const answer = (kind: 'judged' | 'none-declared' = 'judged') =>
  kind === 'judged'
    ? {
        kind,
        status: 'developed',
        declared: ['plan'],
        met: ['plan'],
        unmet: [],
        computedAt: new Date(),
      }
    : { kind, status: 'developed', computedAt: new Date() };

interface Call {
  op: string;
  method: string;
  path: string;
  body?: unknown;
}

/** A client whose publish helper answers from a script and records every call. */
function client(handler: (call: Call) => unknown): { client: Client; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      bindingId: 'binding-1',
      appId: '7',
      owner: 'SidCorp-co',
      repo: 'forge',
      fullName: 'SidCorp-co/forge',
      get: async () => {
        throw new Error('the publish path must not use the read door');
      },
      publish: async (call: Call) => {
        calls.push(call);
        return handler(call);
      },
    } as unknown as Client,
  };
}

const noExistingRun = (call: Call) => (call.op === 'lookup' ? { check_runs: [] } : { id: 11 });

/** The payload a recorded write carried, typed for the assertions below. */
const body = (call: Call | undefined) =>
  (call?.body ?? {}) as { conclusion?: string; output: { title: string; text: string } };

beforeEach(() => {
  vi.clearAllMocks();
  tail = Promise.resolve();
  answerFor.mockResolvedValue(answer());
});

describe('the lookup that decides create from update', () => {
  it('creates when the head carries no run of ours', async () => {
    const { client: c, calls } = client(noExistingRun);
    const published = await publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD });
    expect(calls.map((call) => call.op)).toEqual(['lookup', 'create']);
    expect(published).toMatchObject({ outcome: 'created', checkRunId: 11 });
  });

  it('updates the run already there rather than making a second under one name', async () => {
    const { client: c, calls } = client((call) =>
      call.op === 'lookup' ? { check_runs: [{ id: 404 }] } : { id: 404 },
    );
    const published = await publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD });
    expect(calls.map((call) => call.op)).toEqual(['lookup', 'update']);
    expect(calls[1]?.method).toBe('PATCH');
    expect(calls[1]?.path).toContain('/check-runs/404');
    expect(published).toMatchObject({ outcome: 'updated', checkRunId: 404 });
  });

  // cm:guard `?check_name=` ALONE would match a run another App published under the same name,
  // and PATCHing another App's check run is a 403 that reads exactly like a missing permission.
  it('filters the lookup to this name AND this App', async () => {
    const { client: c, calls } = client(noExistingRun);
    await publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD });
    const lookup = calls[0]?.path ?? '';
    expect(lookup).toContain(`/commits/${HEAD}/check-runs`);
    expect(lookup).toContain(`check_name=${encodeURIComponent(CHECK_RUN_NAME)}`);
    expect(lookup).toContain('app_id=7');
  });

  it('publishes under the one name, on the head it was given', async () => {
    const { client: c, calls } = client(noExistingRun);
    await publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD });
    expect(calls[1]?.body).toMatchObject({ name: CHECK_RUN_NAME, head_sha: HEAD });
  });
});

describe('the serialisation, and what it is around', () => {
  it('takes an advisory lock keyed on the binding AND the head, before anything else', async () => {
    const { client: c } = client(noExistingRun);
    await publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD });
    expect(execute).toHaveBeenCalledTimes(1);
    const [statement] = execute.mock.calls[0] as unknown as [{ queryChunks: unknown[] }];
    const flat = JSON.stringify(statement.queryChunks);
    expect(flat).toContain('pg_advisory_xact_lock');
    expect(flat).toContain(`binding-1:${HEAD}`);
  });

  // cm:guard the ANSWER is computed inside the lock, not before it. Serialising only the write
  // still lets a publish that read first and wrote second replace a newer answer with an older
  // one — a check that reads current and is not.
  it('computes the answer inside the lock, after it is held', async () => {
    const order: string[] = [];
    execute.mockImplementation(async () => {
      order.push('lock');
      return undefined;
    });
    answerFor.mockImplementation(async () => {
      order.push('answer');
      return answer();
    });
    const { client: c } = client((call) => {
      order.push(call.op);
      return call.op === 'lookup' ? { check_runs: [] } : { id: 1 };
    });
    await publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD });
    expect(order).toEqual(['lock', 'answer', 'lookup', 'create']);
  });

  it('makes ONE run out of two overlapping publishes for one head', async () => {
    let created: number | null = null;
    const { client: c, calls } = client((call) => {
      if (call.op === 'lookup') return { check_runs: created === null ? [] : [{ id: created }] };
      if (call.op === 'create') {
        created = 77;
        return { id: created };
      }
      return { id: created };
    });

    const [first, second] = await Promise.all([
      publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD }),
      publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD }),
    ]);

    expect(calls.filter((call) => call.op === 'create')).toHaveLength(1);
    expect([first.outcome, second.outcome].sort()).toEqual(['created', 'updated']);
    expect(first.checkRunId).toBe(77);
    expect(second.checkRunId).toBe(77);
  });

  it('lets the publish that got there LAST be the one that looked last', async () => {
    // The hazard, planted: the FIRST publish reads a slow, and therefore older, answer. With
    // the read inside the lock it cannot start until the second has finished writing, so what
    // GitHub is left holding is the newer one. With the read outside, the slow reader writes
    // last and overwrites a newer answer with an older — a check that reads current and is not.
    const slow = { ...answer('none-declared'), status: 'in_progress' };
    let first = true;
    answerFor.mockImplementation(async () => {
      if (!first) return answer();
      first = false;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return slow;
    });

    let created: number | null = null;
    const { client: c, calls } = client((call) => {
      if (call.op === 'lookup') return { check_runs: created === null ? [] : [{ id: created }] };
      if (call.op === 'create') {
        created = 5;
        return { id: created };
      }
      return { id: created };
    });

    await Promise.all([
      publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD }),
      publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD }),
    ]);

    const written = body(calls.at(-1));
    expect(written.conclusion).toBe('success');
    expect(written.output.title).not.toContain('in_progress');
  });
});

describe('what the write carries', () => {
  it('reports the conclusion the body derived, never one typed here', async () => {
    answerFor.mockResolvedValue({
      kind: 'judged',
      status: 'developed',
      declared: ['plan'],
      met: [],
      unmet: [{ key: 'plan', detail: 'no `plan` is written on this issue' }],
      computedAt: new Date(),
    });
    const { client: c, calls } = client(noExistingRun);
    const published = await publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD });
    expect(published.conclusion).toBe('failure');
    expect(body(calls[1]).conclusion).toBe('failure');
    expect(body(calls[1]).output.text).toContain('no `plan` is written on this issue');
  });

  it('names the issue on the run, so a reader can get back to it', async () => {
    const { client: c, calls } = client(noExistingRun);
    await publishContractCheck(c, { issueId: ISSUE_ID, headSha: HEAD });
    expect(calls[1]?.body).toMatchObject({ external_id: ISSUE_ID, status: 'completed' });
  });
});
