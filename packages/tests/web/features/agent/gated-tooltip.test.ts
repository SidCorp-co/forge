import { describe, expect, it } from 'vitest';
import type { AgentSessionSummary } from '@/features/agent/api';
import { renderGatedTooltip } from '@/features/agent/gated-tooltip';

function makeSession(overrides: Partial<AgentSessionSummary>): AgentSessionSummary {
  return {
    id: 0,
    documentId: 'sess-doc-1',
    title: '',
    status: 'queued',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    ...overrides,
  } as unknown as AgentSessionSummary;
}

describe('renderGatedTooltip', () => {
  it('returns null when failureReason is missing', () => {
    expect(renderGatedTooltip(makeSession({}))).toBeNull();
  });

  it('returns null when failureReason is empty string', () => {
    expect(renderGatedTooltip(makeSession({ failureReason: '' }))).toBeNull();
  });

  it('maps issue_busy → same-issue tooltip', () => {
    const out = renderGatedTooltip(makeSession({ failureReason: 'issue_busy' }));
    expect(out).toBe('Another session is running on this issue — wait for it to finish');
  });

  it('maps project_full → project-cap tooltip', () => {
    const out = renderGatedTooltip(makeSession({ failureReason: 'project_full' }));
    expect(out).toBe('Project is at max parallel issues');
  });

  it('maps runner_full → runner-slot tooltip', () => {
    const out = renderGatedTooltip(makeSession({ failureReason: 'runner_full' }));
    expect(out).toBe('Runner slots are full — waiting for one to free up');
  });

  describe('waiting_on_dep', () => {
    it('renders "Waiting on ISS-X to complete" with a single waitingOn entry', () => {
      const out = renderGatedTooltip(
        makeSession({
          failureReason: 'waiting_on_dep',
          metadata: { waitingOn: [{ issSeq: 12, issueId: 'uuid-1', status: 'in_progress' }] },
        }),
      );
      expect(out).toBe('Waiting on ISS-12 to complete');
    });

    it('joins multiple waitingOn entries with comma', () => {
      const out = renderGatedTooltip(
        makeSession({
          failureReason: 'waiting_on_dep',
          metadata: {
            waitingOn: [
              { issSeq: 12, issueId: 'a', status: 'in_progress' },
              { issSeq: 15, issueId: 'b', status: 'open' },
            ],
          },
        }),
      );
      expect(out).toBe('Waiting on ISS-12, ISS-15 to complete');
    });

    it('falls back to generic copy when metadata.waitingOn is missing', () => {
      const out = renderGatedTooltip(
        makeSession({ failureReason: 'waiting_on_dep', metadata: {} }),
      );
      expect(out).toBe('Waiting on dependency issue to complete');
    });

    it('falls back when waitingOn is not an array', () => {
      const out = renderGatedTooltip(
        makeSession({
          failureReason: 'waiting_on_dep',
          metadata: { waitingOn: 'not-an-array' },
        }),
      );
      expect(out).toBe('Waiting on dependency issue to complete');
    });

    it('skips waitingOn rows that are not objects or lack issSeq', () => {
      const out = renderGatedTooltip(
        makeSession({
          failureReason: 'waiting_on_dep',
          metadata: {
            waitingOn: [
              null,
              'string',
              { issSeq: 7 },
              { notIssSeq: 99 },
              { issSeq: 'string-not-number' },
              { issSeq: 8 },
            ],
          },
        }),
      );
      expect(out).toBe('Waiting on ISS-7, ISS-8 to complete');
    });

    it('falls back when all waitingOn rows are filtered out', () => {
      const out = renderGatedTooltip(
        makeSession({
          failureReason: 'waiting_on_dep',
          metadata: { waitingOn: [null, { irrelevant: true }, 'string'] },
        }),
      );
      expect(out).toBe('Waiting on dependency issue to complete');
    });
  });

  it('returns null for unknown failureReason values (forward-compat)', () => {
    expect(renderGatedTooltip(makeSession({ failureReason: 'queue_timeout' }))).toBeNull();
    expect(renderGatedTooltip(makeSession({ failureReason: 'totally_new_reason' }))).toBeNull();
  });

  it('returns null when failureReason is null explicitly', () => {
    expect(renderGatedTooltip(makeSession({ failureReason: null }))).toBeNull();
  });
});
