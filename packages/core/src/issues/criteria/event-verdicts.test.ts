import { describe, expect, it, vi } from 'vitest';
import { MessageRefusedError } from '../../messaging/contract.js';
import { parseForgeRecord } from '../../messaging/forge-record.js';

const recorded: unknown[] = [];
vi.mock('./store.js', async () => {
  const { verdictDraftFault } = await import('./verdict-input.js');
  class VerdictRefused extends Error {
    constructor(readonly refusal: { code: string; criterion: number; detail: string }) {
      super(refusal.detail);
    }
  }
  return {
    VerdictRefused,
    recordVerdict: async (
      _tx: unknown,
      args: { draft: Parameters<typeof verdictDraftFault>[0] },
    ) => {
      const fault = verdictDraftFault(args.draft);
      if (fault) throw new VerdictRefused(fault);
      recorded.push(args);
      return { id: 'v1' };
    },
  };
});

const { recordEventVerdicts } = await import('./event-verdicts.js');

const tx = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => [{ id: 'iss', projectId: 'p' }] }) }),
  }),
} as never;

const fence = (lines: string[]) =>
  parseForgeRecord(
    ['```forge-record', ...lines, '```', '', '`forge-record: verdict · contract 1`'].join('\n'),
  );

describe('recordEventVerdicts (ISS-55: a verdict record event lands in criterion_verdicts)', () => {
  const actor = { type: 'device' as const, id: 'dev-1', agency: 'agent' as const };

  it('writes each block, with the box as the agent author', async () => {
    recorded.length = 0;
    const n = await recordEventVerdicts(tx, {
      issueId: 'iss',
      record: fence(['criterion: 1', 'verdict: pass', `commit: ${'a'.repeat(40)}`]) as never,
      actor,
      commentId: 'c1',
    });
    expect(n).toBe(1);
    expect(recorded[0]).toMatchObject({
      author: { userId: null, deviceId: 'dev-1', agency: 'agent' },
      commentId: 'c1',
    });
  });

  it('refuses the whole comment by name where a block carries an abbreviated commit', async () => {
    const write = recordEventVerdicts(tx, {
      issueId: 'iss',
      record: fence(['criterion: 1', 'verdict: pass', 'commit: 1810f84']) as never,
      actor,
      commentId: 'c2',
    });
    await expect(write).rejects.toBeInstanceOf(MessageRefusedError);
    await expect(write).rejects.toMatchObject({
      door: 'comment-write',
      refusals: [{ rule: 'VERDICT_COMMIT_NOT_FULL' }],
    });
  });

  it('writes nothing for a record that names no verdict block', async () => {
    expect(
      await recordEventVerdicts(tx, {
        issueId: 'iss',
        record: fence(['criterion: 1']) as never,
        actor,
        commentId: null,
      }),
    ).toBe(0);
  });
});
