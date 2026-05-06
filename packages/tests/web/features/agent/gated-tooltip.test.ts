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

  it('maps issue_busy → vietnamese same-issue tooltip', () => {
    const out = renderGatedTooltip(makeSession({ failureReason: 'issue_busy' }));
    expect(out).toBe('Issue đang chạy session khác — chờ session hiện tại kết thúc');
  });

  it('maps project_full → vietnamese project-cap tooltip', () => {
    const out = renderGatedTooltip(makeSession({ failureReason: 'project_full' }));
    expect(out).toBe('Project đang chạy tối đa số issue song song');
  });

  it('maps runner_full → vietnamese runner-slot tooltip', () => {
    const out = renderGatedTooltip(makeSession({ failureReason: 'runner_full' }));
    expect(out).toBe('Runner đã đầy slot — chờ slot trống');
  });

  describe('waiting_on_dep', () => {
    it('renders "Đợi ISS-X hoàn tất" with a single waitingOn entry', () => {
      const out = renderGatedTooltip(
        makeSession({
          failureReason: 'waiting_on_dep',
          metadata: { waitingOn: [{ issSeq: 12, issueId: 'uuid-1', status: 'in_progress' }] },
        }),
      );
      expect(out).toBe('Đợi ISS-12 hoàn tất');
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
      expect(out).toBe('Đợi ISS-12, ISS-15 hoàn tất');
    });

    it('falls back to generic copy when metadata.waitingOn is missing', () => {
      const out = renderGatedTooltip(
        makeSession({ failureReason: 'waiting_on_dep', metadata: {} }),
      );
      expect(out).toBe('Đợi issue phụ thuộc hoàn tất');
    });

    it('falls back when waitingOn is not an array', () => {
      const out = renderGatedTooltip(
        makeSession({
          failureReason: 'waiting_on_dep',
          metadata: { waitingOn: 'not-an-array' },
        }),
      );
      expect(out).toBe('Đợi issue phụ thuộc hoàn tất');
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
      expect(out).toBe('Đợi ISS-7, ISS-8 hoàn tất');
    });

    it('falls back when all waitingOn rows are filtered out', () => {
      const out = renderGatedTooltip(
        makeSession({
          failureReason: 'waiting_on_dep',
          metadata: { waitingOn: [null, { irrelevant: true }, 'string'] },
        }),
      );
      expect(out).toBe('Đợi issue phụ thuộc hoàn tất');
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
