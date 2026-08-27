import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { buildVerdictEntry } = await import('./phase-journal.js');

describe('buildVerdictEntry', () => {
  it('stamps the verdict as runner-written even when the caller claims to be the agent', () => {
    const entry = buildVerdictEntry({
      runId: 'run-1',
      phase: 'review',
      attempt: 1,
      outcome: 'ok',
      artifact: { kind: 'verdict', decision: 'request_changes' },
      source: 'agent',
    });

    expect(entry.source).toBe('runner');
    expect(entry.artifact).toEqual({ kind: 'verdict', decision: 'request_changes' });
  });

  it('preserves the decision rather than normalising a rejection away', () => {
    const rejected = buildVerdictEntry({
      runId: 'run-1',
      phase: 'review',
      attempt: 2,
      outcome: 'ok',
      artifact: { kind: 'verdict', decision: 'request_changes', findings: [{ file: 'a.ts' }] },
    });

    expect(rejected.artifact).toMatchObject({
      decision: 'request_changes',
      findings: [{ file: 'a.ts' }],
    });
  });

  it('falls back to abstain, not approve, when no verdict was supplied', () => {
    const entry = buildVerdictEntry({
      runId: 'run-1',
      phase: 'review',
      attempt: 1,
      outcome: 'failed',
    });

    expect(entry.artifact).toEqual({ kind: 'verdict', decision: 'abstain' });
    expect(entry.outcome).toBe('failed');
  });
});
