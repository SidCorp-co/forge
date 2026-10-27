import { PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_SESSION_BRIDGE_MARKERS } from '../agent-sessions/terminal-effects.js';
import { contractAnswerForIssue } from '../integrations/github/contract-answer.js';
import { computeProjectProgress } from '../issues/progress.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { ROLE_HOLDER } from '../messaging/audiences.js';
import { gatherFacts } from '../messaging/gather.js';
import { projectLens } from '../messaging/record-screen.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import { rethrowInTransaction } from './in-transaction.js';

vi.mock('../agent-sessions/session-descent.js', () => ({
  DESCENT_SOURCE: 'session-descent',
  closeSessionsOwnedBy: vi.fn(async () => undefined),
}));

/** What a transaction whose server ended its connection answers every statement with. */
const CLOSED = Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' });

/** A drizzle query chain that resolves to no rows, whatever is called on it. */
function emptyChain(): unknown {
  const chain: unknown = new Proxy(() => undefined, {
    get: (_t, prop) =>
      prop === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : () => chain,
  });
  return chain;
}

/** A transaction handle whose first `served` selects find nothing and every later one fails. */
function endedTransaction(served = 0, rows?: unknown[]): never {
  let selects = 0;
  const tx = Object.create(PostgresJsTransaction.prototype) as Record<string, unknown>;
  tx.select = () => {
    selects += 1;
    if (selects > served) throw CLOSED;
    return emptyChain();
  };
  tx.execute = () => {
    throw CLOSED;
  };
  tx.transaction = async () => rows ?? [];
  return tx as never;
}

describe('rethrowInTransaction', () => {
  it('rethrows inside a transaction', () => {
    expect(() => rethrowInTransaction(CLOSED, endedTransaction())).toThrow(CLOSED);
  });

  it('lets the pool keep its fallback', () => {
    expect(() => rethrowInTransaction(CLOSED, { select: () => undefined })).not.toThrow();
  });
});

describe('a read that falls back on failure, run inside a transaction that has ended', () => {
  it('projectLens rethrows instead of reading the lead as product', async () => {
    await expect(projectLens('p1', endedTransaction())).rejects.toBe(CLOSED);
  });

  it('gatherFacts rethrows the issue lookup instead of reporting it failed', async () => {
    await expect(
      gatherFacts({
        projectId: 'p1',
        audience: ROLE_HOLDER,
        intent: 'report',
        segments: ['ISS-1 is done'],
        executor: endedTransaction(2),
      }),
    ).rejects.toBe(CLOSED);
  });

  it('findMissingWorkEvidence rethrows instead of failing open', async () => {
    await expect(findMissingWorkEvidence('i1', endedTransaction())).rejects.toBe(CLOSED);
  });

  it('a session flip rethrows the re-read of a bridge-marked session instead of skipping its bridge', async () => {
    const flipped = [
      { id: 's1', metadata: { [TERMINAL_SESSION_BRIDGE_MARKERS[0] as string]: true } },
    ];
    await expect(
      applyKernelTransition(endedTransaction(0, flipped), {
        entity: 'session',
        to: 'completed',
        returning: ['id'],
        reason: 'test',
        actor: { type: 'system' },
        source: 'test',
      } as never),
    ).rejects.toBe(CLOSED);
  });

  it('the contract check rethrows instead of posting the contract as unreadable', async () => {
    await expect(contractAnswerForIssue('i1', endedTransaction())).rejects.toBe(CLOSED);
  });

  it('the progress figures rethrow instead of leaving them out', async () => {
    await expect(computeProjectProgress('p1', endedTransaction())).rejects.toBe(CLOSED);
  });
});

describe('the same reads on the pool', () => {
  const failing = {
    select: () => {
      throw CLOSED;
    },
    execute: () => {
      throw CLOSED;
    },
  } as never;

  it('the contract check still answers unreadable', async () => {
    await expect(contractAnswerForIssue('i1', failing)).resolves.toMatchObject({
      kind: 'unreadable',
      reason: 'write CONNECTION_CLOSED',
    });
  });

  it('the progress figures are still left out', async () => {
    await expect(computeProjectProgress('p1', failing)).resolves.toBeNull();
  });
});
