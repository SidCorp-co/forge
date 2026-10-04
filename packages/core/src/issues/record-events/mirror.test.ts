import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordEventVerdicts = vi.fn();
const writeRecordEvent = vi.fn();

vi.mock('../criteria/event-verdicts.js', () => ({
  recordEventVerdicts: (...args: unknown[]) => recordEventVerdicts(...args),
}));
vi.mock('./store.js', () => ({
  commentMirrorKey: (id: string) => `record-comment:${id}`,
  writeRecordEvent: (...args: unknown[]) => writeRecordEvent(...args),
}));

const { mirrorCommentRecord } = await import('./mirror.js');

const actor = { type: 'device' as const, id: 'd-1', agency: 'agent' as const };
const tx = {} as never;

const comment = (kind: string, lines: string[]) => ({
  id: 'c-1',
  issueId: 'i-1',
  createdAt: new Date('2026-10-04T00:00:00Z'),
  body: ['```forge-record', ...lines, '```', '', `\`forge-record: ${kind} · contract 1\``].join(
    '\n',
  ),
});

beforeEach(() => {
  recordEventVerdicts.mockReset();
  writeRecordEvent.mockReset();
});

describe('a comment fence of a kernel kind', () => {
  for (const kind of ['park', 'transition']) {
    it(`stores a \`${kind}\` fence as prose and says why, writing no event`, async () => {
      const warnings = await mirrorCommentRecord(
        comment(kind, ['kind: blocked', 'why: waiting on the tenant']),
        actor,
        tx,
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^EVENT_KIND_KERNEL_ONLY: /);
      expect(warnings[0]).toContain(`\`forge-record: ${kind}\``);
      expect(writeRecordEvent).not.toHaveBeenCalled();
      expect(recordEventVerdicts).not.toHaveBeenCalled();
    });
  }

  it('writes a verdict fence as verdict rows, with no comment-level event', async () => {
    recordEventVerdicts.mockResolvedValue(1);
    const warnings = await mirrorCommentRecord(
      comment('verdict', ['criterion: 1', 'verdict: pass', `commit: ${'a'.repeat(40)}`]),
      actor,
      tx,
    );
    expect(warnings).toEqual([]);
    expect(recordEventVerdicts).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ issueId: 'i-1', commentId: 'c-1', actor }),
    );
    expect(writeRecordEvent).not.toHaveBeenCalled();
  });

  it('says so where a verdict fence records no verdict at all', async () => {
    recordEventVerdicts.mockResolvedValue(0);
    const warnings = await mirrorCommentRecord(comment('verdict', ['lead: judged']), actor, tx);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^VERDICT_RECORD_EMPTY: /);
  });

  it('mirrors a kind a caller authors as before', async () => {
    const warnings = await mirrorCommentRecord(
      comment('finding', ['finding: the export drops rows']),
      actor,
      tx,
    );
    expect(warnings).toEqual([]);
    expect(writeRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'finding', commentId: 'c-1' }),
      tx,
    );
  });
});
