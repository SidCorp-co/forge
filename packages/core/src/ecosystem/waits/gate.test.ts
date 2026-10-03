import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Array<Record<string, unknown>> = [];
vi.mock('../../db/client.js', () => ({ db: { execute: vi.fn(async () => rows) } }));
vi.mock('../../issues/issue-prefix-read.js', () => ({ activeIssuePrefix: async () => 'HOP' }));

const { assertWaitsSettledForIssue, ContractWaitUnsettledError } = await import('./gate.js');

const P = '11111111-1111-4111-8111-111111111111';
const wait = (over: Record<string, unknown> = {}) => ({
  iss_seq: 12,
  provider_slug: 'autoflow',
  contract_slug: 'book-follow-up',
  min_version: '2.0.0',
  retracted_at: null,
  settled_at: null,
  current: '1.4.0',
  ...over,
});

async function refusal(): Promise<InstanceType<typeof ContractWaitUnsettledError> | null> {
  try {
    await assertWaitsSettledForIssue(P, 'issue');
    return null;
  } catch (err) {
    if (err instanceof ContractWaitUnsettledError) return err;
    throw err;
  }
}

describe('the run and claim doors refuse an issue whose contract wait is open (E1)', () => {
  beforeEach(() => {
    rows.length = 0;
  });

  it('refuses by name, naming the issue, the contract, the version needed and the one published', async () => {
    rows.push(wait());
    const err = await refusal();
    expect(err?.code).toBe('CONTRACT_WAIT_UNSETTLED');
    expect(err?.blocked).toEqual([
      {
        issue: 'HOP-12',
        contract: 'autoflow/book-follow-up',
        minVersion: '2.0.0',
        current: '1.4.0',
      },
    ]);
    expect(err?.message).toContain('HOP-12 waits on autoflow/book-follow-up >= 2.0.0');
  });

  it('lets a settled or retracted wait through, and an issue with none', async () => {
    expect(await refusal()).toBeNull();
    rows.push(wait({ settled_at: '2026-10-04T00:00:00Z' }));
    rows.push(wait({ retracted_at: '2026-10-04T00:00:00Z' }));
    expect(await refusal()).toBeNull();
  });
});
